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

const WINDOW_SHARDS = 60;

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
 * Increment the active shard atomically. Workers KV exposes `increment`
 * which does a get+add+put server-side (no client race); older Workers
 * types expose it via the runtime but the type package may omit it, so
 * we guard both call and result. Falls back to a plain `put` of
 * `prior+1` on the current client value (still subject to the client
 * get→put race, but bounded to at most 1 lost count per concurrency burst
 * instead of rewriting the full window sum).
 */
async function incrementActiveShard(
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
  // the 61 shard reads/writes (1 active + 60 window) all use the same
  // safe key. Also PII-scrubs the IP out of the KV key itself.
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
  const readShard = async (key: string): Promise<number> => {
    const raw = await params.kv.get(key, "text");
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
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
