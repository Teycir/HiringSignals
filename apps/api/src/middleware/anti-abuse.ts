/**
 * Project-specific anti-abuse middleware.
 *
 * Wraps the reusable primitives in ../../../../lib/* with Hono + Worker
 * Bindings semantics (CACHE KV for rate-limit counters & abuse-signal
 * storage, CF-Connecting-IP as the identifier).
 *
 * One policy: freeReadTier() -> generous per-IP rate limit, no CAPTCHA,
 * no auth. Applied to every route -- the app has no login and no
 * state-changing HTTP surface (spec 3, 13.5, 14.1), so there is nothing
 * that needs a stricter "write tier." Source management is a local ops
 * script against D1, not a Worker route (see infrastructure/scripts/).
 *
 * All decisions are fire-and-forget logged to the CACHE KV namespace via
 * the audit-abuse helper so an operator can inspect trends locally.
 * Log writes never block the response.
 */

import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../bindings";
import {
  checkRateLimit,
  FREE_READ_TIER,
  retryAfterMs,
  type RateLimitParams,
} from "../../../../lib/http/rate-limit";
import {
  recordAbuseEvent,
  AbuseEventType,
  type AbuseEvent,
} from "../../../../lib/observability/audit-abuse";

function fireAndForget<T>(p: Promise<T>): void {
  void p.catch(() => {});
}

function routeLabel(c: { req: { method: string; path: string } }): string {
  return `${c.req.method} ${c.req.path}`;
}

function logAbuse(c: { env: AppEnv["Bindings"] }, ev: Omit<AbuseEvent, "ts" | "ip"> & { ip: string }): void {
  fireAndForget(
    recordAbuseEvent(
      { kv: c.env.CACHE, prefix: "ab:", retentionSeconds: 14 * 24 * 60 * 60 },
      { ts: Date.now(), ...ev },
    ),
  );
}

export function freeReadTier(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // clientIp + default "ok" verdict are set by global client-ip middleware.
    const ip = c.get("clientIp");
    const route = routeLabel(c);

    const rlParams: RateLimitParams = { kv: c.env.CACHE, ...FREE_READ_TIER };
    const decision = await checkRateLimit(ip, rlParams);

    c.header("X-RateLimit-Limit", String(decision.limit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));

    if (!decision.allowed) {
      c.set("abuseVerdict", "rate_limited");
      c.header("Retry-After", retryAfterMs(decision));
      logAbuse(c, {
        type: AbuseEventType.RATE_LIMIT_HIT,
        ip,
        route,
        detail: `429 read tier: ${FREE_READ_TIER.limit}/${FREE_READ_TIER.windowSeconds}s`,
      });
      throw new HTTPException(429, { message: "Too many requests. Slow down." });
    }

    c.set("abuseVerdict", "ok");
    await next();
  };
}
