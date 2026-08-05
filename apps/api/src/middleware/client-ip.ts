/**
 * Populates Variables.clientIp and Variables.abuseVerdict on every request.
 *
 * These two fields are required on the Hono Variables type (not optional),
 * so a global middleware guarantees `c.get("clientIp")`/`c.get("abuseVerdict")`
 * are always defined. Anti-abuse middleware then runs per-route groups and
 * overwrites `abuseVerdict` with its actual decision (rate_limited,
 * captcha_required, downgraded, etc.).
 *
 * IP priority (trusted-first, per security review 2026-07-30 HIGH 3 finding):
 *   1. CF-Connecting-IP (set by Cloudflare edge when orange-cloud is ON;
 *      cannot be spoofed by the connecting client) — use verbatim.
 *   2. Otherwise, use the LAST hop of X-Forwarded-For, which is the IP
 *      closest to the proxy chain we trust (NOT the FIRST hop, which the
 *      connecting client spoofs at will). When the Worker is reachable
 *      without orange-cloud (dev/direct origins), this still prevents an
 *      attacker-controlled X-Forwarded-For[0] bypass that would hand them
 *      a blank slate of rate-limit budget per forged IP.
 *   3. "unknown" — fallback only when no header is present at all (should
 *      never happen for real Cloudflare traffic; keeps types non-optional).
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../bindings";

export function clientIp(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfIp = c.req.header("CF-Connecting-IP");
    let ip: string;
    if (cfIp && cfIp.length > 0) {
      ip = cfIp;
    } else {
      const xff = c.req.header("X-Forwarded-For");
      const hops = xff?.split(",").map((s) => s.trim()).filter((s) => s.length > 0) ?? [];
      ip = hops.at(-1) ?? "unknown";
    }
    c.set("clientIp", ip);
    c.set("abuseVerdict", "ok");
    await next();
  };
}
