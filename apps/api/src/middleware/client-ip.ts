/**
 * Populates Variables.clientIp and Variables.abuseVerdict on every request.
 *
 * These two fields are required on the Hono Variables type (not optional),
 * so a global middleware guarantees `c.get("clientIp")`/`c.get("abuseVerdict")`
 * are always defined. Anti-abuse middleware then runs per-route groups and
 * overwrites `abuseVerdict` with its actual decision (rate_limited,
 * captcha_required, downgraded, etc.).
 *
 * IP priority: CF-Connecting-IP (trusted edge header on Cloudflare) > first
 * hop of X-Forwarded-For > "unknown" (should never happen for real traffic,
 * but guards against direct origin hits in dev).
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../bindings";

export function clientIp(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",").at(0)?.trim() ??
      "unknown";
    c.set("clientIp", ip);
    c.set("abuseVerdict", "ok");
    await next();
  };
}
