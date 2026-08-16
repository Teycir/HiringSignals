/**
 * Admin authentication middleware (spec 13.5, ROADMAP Milestone admin-auth).
 *
 * Four-layer defense, matching ArxivExplorer's hardened pattern:
 *   1. Fail-closed: if ADMIN_SECRET binding is unset (not a wrangler secret),
 *      every admin route returns 403 regardless of request headers.
 *   2. Constant-time comparison via node:crypto's timingSafeEqual — never
 *      === or localeCompare, both of which leak byte-difference information
 *      through timing side channels.
 *   3. Per-IP strike counter in ABUSE_LOGS KV, keyed on SHA-256(IP) so raw
 *      PII never appears in KV key strings (security review CWE-20/74
 *      finding: IPv6 colons and arbitrary XFF content previously caused
 *      shard-key ambiguity via the `:` separator in KV keys).
 *   4. 3-strike / 60s lockout: after 3 failed attempts in a 60s window,
 *      the IP is locked out for the remainder of the window regardless
 *      of subsequent attempts. Strike window resets passively via KV TTL.
 *
 * All auth events (success, wrong_secret, locked_out, secret_unset) are
 * fire-and-forget appended to ABUSE_LOGS KV via recordAbuseEvent so
 * operator tooling can inspect trends. Writes never block the response.
 *
 * Token transport: clients MUST send `Authorization: Bearer <SECRET>`.
 * A query param fallback is intentionally NOT supported — query strings
 * end up in server logs, CDN logs, browser history, and Referer headers.
 */

import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { AppEnv } from "../bindings";
import {
  recordAbuseEvent,
  AbuseEventType,
  type AbuseEvent,
} from "../../../../lib/observability/audit-abuse";
import { incrementActiveShard } from "../../../../lib/http/rate-limit";

const ADMIN_RL_STRIKE_LIMIT = 3;
const ADMIN_RL_WINDOW_SECONDS = 60;
const ADMIN_RL_KEY_PREFIX = "admin:rl:";
const ABUSE_LOG_RETENTION_S = 14 * 24 * 60 * 60;

function fireAndForget<T>(p: Promise<T>): void {
  void p.catch(() => {});
}

function routeLabel(c: { req: { method: string; path: string } }): string {
  return `${c.req.method} ${c.req.path}`;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    // noUncheckedIndexedAccess: bytes[i] is number | undefined even though
    // the loop bound guarantees it's in range -- a real fallback (not a
    // non-null assertion) per this repo's own indexed-access rule
    // (AGENTS.md). digest bytes are never actually undefined here since i
    // < bytes.length always holds, but 0 keeps the hex string well-formed
    // (two hex chars) even in a hypothetical out-of-bounds case rather
    // than emitting "undefined" into what becomes a KV key/log field.
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function logAbuse(
  c: { env: AppEnv["Bindings"] },
  ev: Omit<AbuseEvent, "ts" | "ip"> & { ip: string },
): void {
  fireAndForget(
    recordAbuseEvent(
      { kv: c.env.ABUSE_LOGS, prefix: "ab:", retentionSeconds: ABUSE_LOG_RETENTION_S },
      { ts: Date.now(), ...ev },
    ),
  );
}

/** Exported for direct unit testing (apps/api/test/middleware/admin-auth.test.ts)
 * -- pure function, exporting it doesn't change adminAuth()'s runtime behavior.
 *
 * Bug found and fixed 2026-08-08 while adding this file's first real test
 * coverage: `crypto.subtle.timingSafeEqual` is not a real Web Crypto API
 * method (neither the browser standard nor the Workers runtime expose it)
 * -- every call threw `TypeError: crypto.subtle.timingSafeEqual is not a
 * function`, so the timing-oracle fix in commit 78a68cf had never actually
 * executed successfully; adminAuth() always 500'd before this had a test to
 * catch it. The real constant-time primitive lives in `node:crypto`
 * (available here because `wrangler.toml` sets `compatibility_flags =
 * ["nodejs_compat"]`) as a synchronous `timingSafeEqual(a, b)` that requires
 * equal-length inputs -- hence the explicit pad-to-maxLen step below still
 * matters, not just for the timing property but to satisfy that precondition. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);

  // Compare fixed-length buffers so a wrong-length bearer token does not
  // return before the constant-time comparison. Length still must match for
  // a valid token, but folding that check into the final boolean avoids an
  // easy remote timing oracle for ADMIN_SECRET length.
  const maxLen = Math.max(aBuf.byteLength, bBuf.byteLength);
  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBuf);
  bPadded.set(bBuf);

  const bytesMatch = nodeTimingSafeEqual(aPadded, bPadded);
  return bytesMatch && aBuf.byteLength === bBuf.byteLength;
}

interface StrikeState {
  strikes: number;
  lockedOut: boolean;
  resetAt: number;
}

/**
 * Window bucketing for the strike counter. Rather than storing
 * `{strikes, windowStartSec}` as one JSON blob (the pre-S.3 shape, which
 * requires a read-modify-write to bump `strikes` and is therefore racy
 * under concurrent requests from the same IP -- see addStrike below), the
 * window itself is folded into the KV key: `windowStartSec` is rounded
 * down to a fixed-size bucket, so all requests within the same
 * ADMIN_RL_WINDOW_SECONDS window agree on the same key without needing to
 * coordinate through a read first. The strike count at that key is then a
 * bare integer, incrementable via the same atomic
 * `incrementActiveShard`/KV-`increment` primitive lib/http/rate-limit.ts
 * already uses to close this exact class of race for the sliding-window
 * rate limiter (roadmap S.3, spec §11.1).
 */
function windowStartSecFor(nowSec: number): number {
  return Math.floor(nowSec / ADMIN_RL_WINDOW_SECONDS) * ADMIN_RL_WINDOW_SECONDS;
}

async function loadStrikes(
  kv: AppEnv["Bindings"]["ABUSE_LOGS"],
  ipHash: string,
): Promise<StrikeState & { key: string; ttl: number; windowStartSec: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = windowStartSecFor(nowSec);
  const key = `${ADMIN_RL_KEY_PREFIX}${ipHash}:${windowStartSec}`;
  const ttl = ADMIN_RL_WINDOW_SECONDS + 5;

  const raw = await kv.get(key, "text");
  let strikes = 0;
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) strikes = Math.floor(n);
  }

  return {
    strikes,
    lockedOut: strikes >= ADMIN_RL_STRIKE_LIMIT,
    resetAt: (windowStartSec + ADMIN_RL_WINDOW_SECONDS) * 1000,
    key,
    ttl,
    windowStartSec,
  };
}

async function addStrike(
  kv: AppEnv["Bindings"]["ABUSE_LOGS"],
  s: Awaited<ReturnType<typeof loadStrikes>>,
): Promise<number> {
  if (s.lockedOut) return s.strikes;
  // Atomic bump via KV's native increment (falls back to a bounded-loss
  // client put when the runtime doesn't expose `increment` -- same
  // fallback contract as checkRateLimit's sliding-window shards). Closes
  // the get-then-put race a burst of concurrent wrong-password attempts
  // from the same IP used to hit: previously every concurrent request
  // could read the same prior `strikes` value before any of them wrote,
  // undercounting strikes and stretching the lockout window past its
  // intended threshold.
  return incrementActiveShard(kv, s.key, s.ttl, s.strikes);
}

export function adminAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = c.get("clientIp");
    const route = routeLabel(c);
    const ipHash = await sha256Hex(ip);

    if (!c.env.ADMIN_SECRET || typeof c.env.ADMIN_SECRET !== "string" || c.env.ADMIN_SECRET.length === 0) {
      logAbuse(c, {
        type: AbuseEventType.ADMIN_WRITE_UNVERIFIED,
        ip,
        route,
        detail: "403 admin: ADMIN_SECRET binding unset",
        meta: { ip_hash: ipHash },
      });
      throw new HTTPException(403, { message: "Admin access disabled." });
    }

    const strikeState = await loadStrikes(c.env.ABUSE_LOGS, ipHash);
    if (strikeState.lockedOut) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((strikeState.resetAt - Date.now()) / 1000))));
      logAbuse(c, {
        type: AbuseEventType.ADMIN_WRITE_UNVERIFIED,
        ip,
        route,
        detail: `429 admin: ${strikeState.strikes} strikes in ${ADMIN_RL_WINDOW_SECONDS}s`,
        meta: { ip_hash: ipHash, strikes: strikeState.strikes },
      });
      throw new HTTPException(429, { message: "Too many failed attempts. Try again later." });
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const afterStrike = await addStrike(c.env.ABUSE_LOGS, strikeState);
      logAbuse(c, {
        type: AbuseEventType.ADMIN_WRITE_UNVERIFIED,
        ip,
        route,
        detail: "401 admin: missing or malformed Authorization header",
        meta: { ip_hash: ipHash, strikes: afterStrike },
      });
      c.header("WWW-Authenticate", "Bearer");
      throw new HTTPException(401, { message: "Admin credentials required." });
    }

    const provided = authHeader.slice("Bearer ".length);
    const ok = await timingSafeEqualStrings(provided, c.env.ADMIN_SECRET);
    if (!ok) {
      const afterStrike = await addStrike(c.env.ABUSE_LOGS, strikeState);
      logAbuse(c, {
        type: AbuseEventType.ADMIN_WRITE_UNVERIFIED,
        ip,
        route,
        detail: "403 admin: wrong ADMIN_SECRET",
        meta: { ip_hash: ipHash, strikes: afterStrike },
      });
      throw new HTTPException(403, { message: "Invalid admin credentials." });
    }

    logAbuse(c, {
      type: AbuseEventType.AUDIT_SIGNAL_WRITE,
      ip,
      route,
      detail: "admin auth success",
      meta: { ip_hash: ipHash, strikes: strikeState.strikes },
    });

    await next();
  };
}
