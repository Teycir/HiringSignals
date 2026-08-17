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
  "https://hiring-signals-web.teycircoder14.workers.dev",
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
    // Set the per-origin reflection headers BEFORE calling base(), not
    // after. base() returns an already-finalized Response for OPTIONS
    // (via c.body(null, 204)) and Hono's c.header() calls made after a
    // Response has already been constructed do not mutate it -- confirmed
    // against this repo's Hono version: a c.header() call issued after
    // c.body() returns is silently a no-op on the returned Response.
    // Setting AC-A-O/Vary here first means base()'s own c.body(null, 204)
    // call picks them up as already-pending headers when it serializes the
    // response, same as how base() sets Access-Control-Allow-Methods/
    // -Headers on that path today. Getting this ordering wrong previously
    // meant every real cross-origin OPTIONS preflight came back without
    // Access-Control-Allow-Origin at all -- the browser would block the
    // follow-up request regardless of what the actual GET/POST response
    // later set, a strictly worse bug than the S.2 credentials issue this
    // wrapper was written to fix.
    if (ALLOW_ALL_ORIGINS && origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      // Deliberately NOT setting Access-Control-Allow-Credentials here
      // (roadmap S.2, spec §11.1). Reflected-origin + credentials=true is
      // the specific pattern browsers use wildcard+credentials blocking
      // to prevent -- combined, every origin on the internet becomes a
      // trusted credentialed reader of this response. No route on this
      // Worker sets cookies or reads browser-supplied Authorization
      // headers today, so this is inert either way, but only omitting it
      // keeps that true structurally instead of by accident. Re-add
      // credentials=true only alongside whatever future change actually
      // introduces a credentialed route, scoped to real allowed origins
      // at that point (drop ALLOW_ALL_ORIGINS reflection for that route),
      // not blanket reflection.
    }
    // base() returns a Response for OPTIONS (c.body(null, 204), no next()
    // call) and returns undefined for every other method (it calls
    // await next() internally instead). We must propagate whatever it
    // returns -- dropping the OPTIONS Response here left Hono's context
    // unfinalized ("Context is not finalized. Did you forget to return a
    // Response object or `await next()`?"), a real bug that broke every
    // CORS preflight in local dev.
    return base(c, next);
  };
}
