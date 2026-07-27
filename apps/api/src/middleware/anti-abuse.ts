/**
 * Project-specific anti-abuse middleware.
 *
 * Wraps the reusable primitives in ../../../../lib/* with Hono + Worker
 * Bindings semantics (CACHE KV for rate-limit counters & abuse-signal
 * storage, TURNSTILE_SECRET_KEY env for CAPTCHA verification,
 * CF-Connecting-IP as the identifier).
 *
 * Two policies:
 *   freeReadTier()   -> generous per-IP rate limit, no CAPTCHA.
 *                       Applied to GET /signals, /companies, /facets, /health.
 *   protectedWriteTier(actionName) -> tight per-IP rate limit + Turnstile.
 *                       Applied to POST /admin/sources, PATCH /admin/sources,
 *                       POST /admin/ingestion/run. Gracefully degrades to
 *                       rate-limit-only if TURNSTILE_SECRET_KEY isn't set
 *                       (no 401s in dev).
 *
 * All decisions are fire-and-forget logged to the CACHE KV namespace via
 * the audit-abuse helper so the admin UI can surface trends. Log writes
 * never block the response.
 */

import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../bindings";
import {
  checkRateLimit,
  FREE_READ_TIER,
  PROTECTED_WRITE_TIER,
  retryAfterMs,
  type RateLimitParams,
} from "../../../../lib/http/rate-limit";
import { verifyTurnstile } from "../../../../lib/http/turnstile";
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

export interface ProtectedWriteOptions {
  /** Human-readable action name that the CAPTCHA sitekey is expected to sign. */
  action: string;
  /** If true, a missing Turnstile secret still allows the request (downgrade). If false, 401 when CAPTCHA can't be verified. */
  allowCaptchaDowngrade?: boolean;
}

export function protectedWriteTier(opts: ProtectedWriteOptions): MiddlewareHandler<AppEnv> {
  const allowDowngrade = opts.allowCaptchaDowngrade ?? true;

  return async (c, next) => {
    // clientIp + default "ok" verdict are set by global client-ip middleware.
    const ip = c.get("clientIp");
    const route = routeLabel(c);

    const rlParams: RateLimitParams = { kv: c.env.CACHE, ...PROTECTED_WRITE_TIER };
    const rl = await checkRateLimit(ip, rlParams);
    c.header("X-RateLimit-Limit", String(rl.limit));
    c.header("X-RateLimit-Remaining", String(rl.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));

    if (!rl.allowed) {
      c.set("abuseVerdict", "rate_limited");
      c.header("Retry-After", retryAfterMs(rl));
      logAbuse(c, {
        type: AbuseEventType.RATE_LIMIT_HIT,
        ip,
        route,
        detail: `429 write tier (${opts.action}): ${PROTECTED_WRITE_TIER.limit}/${PROTECTED_WRITE_TIER.windowSeconds}s`,
      });
      throw new HTTPException(429, { message: "Too many write requests." });
    }

    const secret = c.env.TURNSTILE_SECRET_KEY;
    const token = c.req.header("X-Turnstile-Token") ?? c.req.query("turnstile");

    if (!secret) {
      if (allowDowngrade) {
        c.set("abuseVerdict", "downgraded");
        await next();
        return;
      }
      logAbuse(c, { type: AbuseEventType.CAPTCHA_MISSING, ip, route, detail: "CAPTCHA secret not configured, strict mode" });
      throw new HTTPException(401, { message: "Anti-abuse CAPTCHA not configured on the server." });
    }

    if (!token) {
      logAbuse(c, { type: AbuseEventType.CAPTCHA_MISSING, ip, route, detail: "No X-Turnstile-Token header" });
      c.set("abuseVerdict", "captcha_required");
      throw new HTTPException(401, {
        message: "A CAPTCHA token is required for this action. Pass X-Turnstile-Token header or ?turnstile= query param.",
      });
    }

    const captcha = await verifyTurnstile({
      secret,
      token,
      remoteIp: ip === "unknown" ? undefined : ip,
      action: opts.action,
      strict: false,
    });

    if (captcha.disabled && allowDowngrade) {
      c.set("abuseVerdict", "downgraded");
      await next();
      return;
    }

    if (!captcha.verified) {
      c.set("abuseVerdict", "captcha_failed");
      logAbuse(c, {
        type: AbuseEventType.CAPTCHA_FAILED,
        ip,
        route,
        detail: `action=${opts.action} codes=${captcha.errorCodes.join(",") || "none"}`,
      });
      throw new HTTPException(401, { message: "CAPTCHA verification failed." });
    }

    c.set("abuseVerdict", "ok");
    await next();
  };
}
