/**
 * KV-backed sliding-window rate limiter for Cloudflare Workers.
 *
 * Inspired by Timeseal's rateLimit.ts pattern, but reworked for a Hono
 * worker: no in-process Map (workers have per-request memory; cross-request
 * sharing only works via KV/D1), and sliding-window via KV atomic counters
 * with per-minute window shards. A TTL equal to window size keeps the store
 * clean without a sweep job.
 *
 * Two tiers are preconfigured in this file, but callers can also build
 * their own:
 *   - FREE_READ_TIER   : generous per-IP budget for anonymous signal reads
 *   - PROTECTED_WRITE_TIER : tight per-IP budget for a state-changing route,
 *     if a consuming project ever adds one. Hiring Signals itself has no
 *     state-changing HTTP routes (source management is a local ops script,
 *     not a Worker route -- spec 13.5) so only FREE_READ_TIER is wired up
 *     here today; this tier is kept as a ready-made option for reuse.
 *
 * Zero project-specific dependencies -- copy this file into any Hono-based
 * Cloudflare Worker that has a KV namespace available.
 */

import type { KVNamespace } from "@cloudflare/workers-types";

export interface RateLimitParams {
  /** Which namespace backs the counter. */
  kv: KVNamespace;
  /** Human-readable key prefix, e.g. "rl:read:" or "rl:write:". */
  keyPrefix: string;
  /** Max tokens allowed in the window. */
  limit: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

// Number of rotating counters the sliding window is split into.
//
// Trimmed 60 -> 30 (2026-09-02 prod incident, same KV-quota exhaustion
// this file's readShard try/catch above was fixed for): every request
// through freeReadTier() pays 1 write + up to (WINDOW_SHARDS - 1) reads
// here, and this middleware runs on EVERY route -- at the old value of
// 60 that was up to 59 reads/request, meaning the KV free tier's read
// cap (100,000/day) worked out to roughly 1,700 requests/day before the
// app started throwing, well below real traffic. The write count is
// fixed at 1 regardless of WINDOW_SHARDS (only the active shard is ever
// written), so the write cap (1,000/day) doesn't move here -- but the
// read count scales linearly with WINDOW_SHARDS, so this is the one
// knob in this file that meaningfully reduces read-quota pressure. At
// 30, with FREE_READ_TIER's windowSeconds=300, each shard covers 10s
// instead of the old 5s -- a modest halving of both read volume and
// sliding-window granularity, chosen over a more aggressive cut (e.g.
// 10) to keep the precision loss small while still meaningfully
// reducing read pressure; FREE_READ_TIER is a generous 600-req/300s
// anonymous limit, not a tight anti-abuse tripwire, so losing precision
// at the 10s vs 5s boundary has no practical effect on what it's
// actually guarding against. Callers needing finer granularity for a
// tighter-limit tier (see PROTECTED_WRITE_TIER's own comment -- unused
// today) can still pass a smaller windowSeconds; WINDOW_SHARDS is a
// fixed tradeoff constant for this file's expected KV budget, not meant
// to vary per tier.
const WINDOW_SHARDS = 30;

/**
 * Safe identifier for rate-limit keys. Identifiers that are allowed to
 * contain the key-part separator (":") — most notably IPv6 addresses like
 * `2001:db8::1` — break the shard-key structure
 * `${prefix}${identifier}:${shardIndex}` because we cannot tell where the
 * identifier ends and the shard index begins. Two identifiers that share a
 * prefix-up-to-a-colon then bleed counters into each other's shards,
 * defeating the rate limit (security review 2026-07-30 HIGH 1 finding).
 *
 * To avoid this, hash the raw identifier with SHA-256 and base64url-encode
 * the digest: 32 bytes → 43 base64url chars, all URL-safe (no colons, no
 * slashes), no internal separator. Hashing also prevents KV keys from
 * containing PII (client IPs) in plaintext — useful if a third-party ever
 * needs to list namespace contents for debugging.
 *
 * Uses the WebCrypto API only (Cloudflare Workers and Node 18+ both have
 * it), with a graceful fallback to the raw identifier on the astronomically
 * unlikely path that crypto.subtle.digest itself throws. On that fallback
 * path we still don't crash the hot path: we just lose the separator
 * safety net, same behavior as before this fix.
 */
export async function safeRateLimitIdentifier(raw: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    // base64url encode without padding (same algorithm as lib/text/base64url.ts
    // bufferToBase64Url; reproduced here to avoid a cross-module import so
    // this file remains zero-dependency and copy-pasteable into any project).
    const u8 = new Uint8Array(digest);
    let binary = "";
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]!);
    const b64 = btoa(binary);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    // Degrade to raw on digest-throw; never let crypto failures take down
    // the request path. Still better than crashing, per project preference
    // for graceful degradation of security primitives.
    return raw;
  }
}

/**
 * Increment a KV-backed integer counter atomically. Workers KV exposes
 * `increment` which does a get+add+put server-side (no client race);
 * older Workers types expose it via the runtime but the type package may
 * omit it, so we guard both call and result. Falls back to a plain `put`
 * of `prior+1` on the current client value (still subject to the client
 * get→put race, but bounded to at most 1 lost count per concurrency burst
 * instead of rewriting the full window sum).
 *
 * Exported (not just used internally for rate-limit shards) so any other
 * KV-backed counter in this codebase -- e.g. admin-auth.ts's strike
 * counter, roadmap S.3 -- can close the same get→put race with the same
 * primitive instead of re-deriving it.
 */
export async function incrementActiveShard(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  prior: number,
): Promise<number> {
  // Workers KV `increment` is a runtime method that @cloudflare/workers-types
  // bundles do not always declare; cast through `any` since types may omit
  // it even when it exists at runtime. If missing, fall back to a client-side
  // put of prior+1 (subject to get→put races, but bounded to at most one
  // lost count per concurrency burst — better than blowing up types).
  try {
    const kvAny = kv as unknown as {
      increment?: (k: string, amount: number, opts?: { expirationTtl: number }) => Promise<number>;
    };
    if (typeof kvAny.increment === "function") {
      const r = await kvAny.increment(key, 1, { expirationTtl: ttlSeconds });
      if (typeof r === "number") return r;
    }
  } catch {
    // fall through to manual bump
  }
  try {
    await kv.put(key, String(prior + 1), { expirationTtl: ttlSeconds });
  } catch {
    // swallow write failures on the hot path -- we still allow+count the
    // request via the local prior+1 return value, so limits only degrade
    // during KV write outages, never collapse to 429 or allow unbounded.
  }
  return prior + 1;
}

export async function checkRateLimit(
  identifier: string,
  params: RateLimitParams,
): Promise<RateLimitDecision> {
  // Hash identifier before constructing shard keys (see safeRateLimitIdentifier
  // docstring for why: IPv6 colons + separator injection would defeat the
  // rate limit otherwise). Do this once at the top of checkRateLimit so
  // all of this call's shard reads/writes (1 active + up to
  // WINDOW_SHARDS-1 window, see that constant's own comment for the
  // exact budget) use the same safe key. Also PII-scrubs the IP out of
  // the KV key itself.
  const safeId = await safeRateLimitIdentifier(identifier);

  const nowSec = Math.floor(Date.now() / 1000);
  const shardSizeSec = Math.max(1, Math.floor(params.windowSeconds / WINDOW_SHARDS));
  const activeShard = Math.floor(nowSec / shardSizeSec) % WINDOW_SHARDS;
  const shardStartSec = Math.floor(nowSec / shardSizeSec) * shardSizeSec;
  const windowStartSec = nowSec - params.windowSeconds + 1;
  const ttl = params.windowSeconds + shardSizeSec * 2;

  // Read a counter shard from KV. Values are stored as text (String(n)) by
  // put() above, so the matching read is text + numeric coercion, NOT the
  // "cacheMetadata" positional form (which doesn't exist on KVNamespace.get
  // in @cloudflare/workers-types bundles).
  //
  // Wrapped in try/catch (2026-09-02 prod incident): this runs up to
  // WINDOW_SHARDS-1 times per request across EVERY route (freeReadTier()
  // is global middleware), so it's by far the highest-volume KV consumer
  // in the app -- far more than trends.ts/facets.ts's own cache reads.
  // An unguarded throw here (KV quota exceeded, or any transient KV
  // error) was propagating all the way up through checkRateLimit ->
  // freeReadTier -> Hono's error handler as an unhandled exception,
  // returning a generic 500 "Something went wrong processing the
  // request" for EVERY route, not just the one whose handler happened
  // to touch KV -- explains "worked, then failed on refresh" (quota is
  // cumulative across the day; early requests succeed, later ones don't)
  // better than any single route's own logic could. Same "degrade, don't
  // crash the hot path" convention incrementActiveShard below already
  // uses for KV write failures: treat an unreadable shard as 0 rather
  // than failing the whole rate-limit check. Worst case this undercounts
  // the window (a slightly too-generous limit during a KV outage), which
  // is the correct fail-open direction for a read-tier limiter -- never
  // fail closed (429/500) on infrastructure trouble unrelated to the
  // caller's actual request volume.
  const readShard = async (key: string): Promise<number> => {
    try {
      const raw = await params.kv.get(key, "text");
      if (raw == null) return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  };

  // First read the active shard alone so we can atomically bump it and
  // avoid re-fetching it in the multi-shard loop below.
  const activeKey = `${params.keyPrefix}${safeId}:${activeShard}`;
  const activePrior = await readShard(activeKey);

  // Atomically add 1 to the active shard. activeShardNew = value after the increment.
  const activeShardNew = await incrementActiveShard(params.kv, activeKey, ttl, activePrior);

  // Now fetch the remaining shards in parallel (skip index 0 == activeShard,
  // which we already accounted for via activeShardNew).
  const shardPromises: Array<Promise<number>> = [];
  for (let i = 1; i < WINDOW_SHARDS; i++) {
    const shardIndex = (activeShard - i + WINDOW_SHARDS) % WINDOW_SHARDS;
    const shardBase = shardStartSec - i * shardSizeSec;
    if (shardBase + shardSizeSec < windowStartSec) break;
    const key = `${params.keyPrefix}${safeId}:${shardIndex}`;
    shardPromises.push(readShard(key));
  }
  const otherShards = await Promise.all(shardPromises);

  let windowTotal = activeShardNew;
  for (const c of otherShards) windowTotal += c;

  if (windowTotal >= params.limit) {
    return {
      allowed: false,
      remaining: 0,
      limit: params.limit,
      resetAt: (windowStartSec + params.windowSeconds) * 1000,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, params.limit - windowTotal),
    limit: params.limit,
    resetAt: (windowStartSec + params.windowSeconds) * 1000,
  };
}

export const FREE_READ_TIER: Omit<RateLimitParams, "kv"> = {
  keyPrefix: "rl:read:",
  limit: 600,
  windowSeconds: 300,
};

export const PROTECTED_WRITE_TIER: Omit<RateLimitParams, "kv"> = {
  keyPrefix: "rl:write:",
  limit: 30,
  windowSeconds: 300,
};

export function retryAfterMs(decision: RateLimitDecision): string {
  return String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)));
}
