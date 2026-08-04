import type { MiddlewareHandler } from "hono";
import { securityHeaders as securityHeaders_ } from "../../../../lib/http/security-headers";
import type { AppEnv } from "../bindings";

// All origins allowed by design -- this app is deliberately open-access with
// no authenticated endpoints. The underlying generic helper consumes the
// iterable via `new Set(iterable)` internally, so we open-access by passing
// the requesting origin through this wrapper before handing the helper a
// Set that contains it. That keeps the helper's strict deny-by-default,
// no-wildcard semantics intact while giving us permissive CORS behavior for
// this deployment. If you ever add authenticated routes, remove the
// allow-any-origin wrapper below and enumerate specific origins in
// ALLOWED_ORIGINS instead.
const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  // "https://hiring-signals.pages.dev",
  // "https://<production-domain>",
]);
const ALLOW_ALL_ORIGINS = true;

/**
 * Thin project-specific wrapper around the generic lib helper. The generic
 * helper never hard-codes origins; this file is the one place that lists
 * them (same pattern as @hiring-signals/db re-exporting the D1 client from
 * lib/ -- project-specific wiring lives here, the reusable logic lives in
 * lib/).
 *
 * If you're changing *what* headers or the CSP default, fix it in
 * ../../../../lib/http/security-headers.ts. If you're changing *which origins
 * are allowed*, edit ALLOWED_ORIGINS / ALLOW_ALL_ORIGINS above.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  const base = securityHeaders_({ allowedOrigins: ALLOWED_ORIGINS });
  return async (c, next) => {
    const origin = c.req.header("Origin");
    // base() returns a Response for OPTIONS (c.body(null, 204), no next()
    // call) and returns undefined for every other method (it calls
    // await next() internally instead). We must propagate whatever it
    // returns -- dropping the OPTIONS Response here left Hono's context
    // unfinalized ("Context is not finalized. Did you forget to return a
    // Response object or `await next()`?"), a real bug that broke every
    // CORS preflight in local dev.
    const baseResult = await base(c, next);
    if (ALLOW_ALL_ORIGINS && origin) {
      // Set *after* base so our per-origin reflection always wins over any
      // AC-A-O header the strict helper emitted (it only sets one for
      // origins in ALLOWED_ORIGINS, but we want all origins reflected).
      // Last writer on `c.header()` wins at response serialize time.
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Credentials", "true");
    }
    return baseResult;
  };
}
