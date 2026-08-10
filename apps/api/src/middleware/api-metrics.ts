import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../bindings";

/**
 * Records one Workers Analytics Engine data point per completed request
 * (spec §16.3: "monitoring exposes ingestion success, source health, and
 * API error rates" -- source-health.mjs already covers the first two;
 * this middleware is what closes the third, previously unbuilt gap, see
 * ROADMAP.md).
 *
 * Registered via app.use("*", ...) immediately after requestId() (needs
 * c.get("requestId") available) and before the route tree, same
 * positioning as clientIp()/securityHeaders() -- see index.ts's own
 * "Middleware order follows spec 13.2" comment.
 *
 * Placed AFTER `await next()` resolves, not wrapped in try/catch around
 * it: Hono's own contract is that next() never throws -- an error
 * thrown by a handler or downstream middleware is caught internally and
 * routed to app.onError() (errorHandler.ts), which sets c.res itself
 * before control returns here. So c.res.status below already reflects
 * whatever errorHandler produced for a thrown error, with no need to
 * catch anything from next() itself.
 *
 * `writeDataPoint` IS wrapped in its own try/catch, for a different
 * reason: it's synchronous and can throw at the call site (e.g. binding
 * unset, args malformed) -- if it did, letting that propagate would fail
 * a request that otherwise succeeded, which would make "record a metric"
 * a worse bug than "no metric was recorded." A dropped data point is an
 * acceptable loss; an API request failing because ITS OWN metrics write
 * failed is not.
 *
 * Local-dev behavior (verified live against this repo's wrangler 4.114.0
 * on 2026-08-11, not assumed from docs): `wrangler dev` reports
 * env.API_METRICS as Mode: local, and it is a real, defined
 * AnalyticsEngineDataset stub -- writeDataPoint() completed without
 * throwing or logging any warning across GET /api/v1/signals (200),
 * GET /api/v1/signals/:id with a bad id (400), and an unmatched route
 * (404). So the `!dataset` guard below does not currently fire in local
 * dev under this wrangler version. It is kept anyway as a genuine
 * defensive check for any environment/version where the binding truly
 * isn't provisioned (e.g. an env without the wrangler.toml entry, or a
 * future/older wrangler that reverts to leaving it undefined) -- cost of
 * keeping it is one cheap falsy check; cost of removing it is a crash
 * the day that assumption stops holding.
 */
export function apiMetrics(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    await next();
    const durationMs = Date.now() - startedAt;

    const dataset = c.env.API_METRICS;
    if (!dataset) {
      // Does not fire under this repo's current wrangler/local-dev setup
      // (see header comment) -- kept for any env/version where the
      // binding truly isn't provisioned. Not logged, since that would
      // fire on every request rather than once at startup, and there's
      // no per-request actionable signal in "the binding is absent,"
      // only a one-time deployment concern.
      return;
    }

    try {
      dataset.writeDataPoint({
        blobs: [c.req.method, normalizeRoutePath(new URL(c.req.url).pathname)],
        doubles: [c.res.status, durationMs],
        // index1: route shape (not literal path -- see normalizeRoutePath),
        // so Analytics Engine's own sampling-by-index behavior groups by
        // "which endpoint," not by "which specific resource id," keeping
        // cardinality bounded to the route table rather than growing with
        // every signal/company ever created.
        indexes: [normalizeRoutePath(new URL(c.req.url).pathname)],
      });
    } catch (err) {
      console.error("api_metrics_write_failed", {
        requestId: c.get("requestId"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Collapses path segments that are resource identifiers (UUIDs, or a
 * company slug) into a fixed placeholder, so /api/v1/signals/<uuid> and
 * /api/v1/companies/<any-slug> both record under one stable route shape
 * instead of one Analytics Engine index value per resource ever
 * requested. UUID detection covers signalId/sourceId (both
 * crypto.randomUUID() per signal-id-param.ts's own header comment);
 * slug detection is intentionally broad (any lowercase-alnum-hyphen
 * segment that isn't a known static route word) since companies.slug
 * has no fixed prefix marking it as a param the way /:signalId does
 * -- see company-slug-param.ts for the exact slug shape this mirrors.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Static route words this API ever uses as a literal path segment --
// anything NOT in this set, appearing where a param slot could be, is
// treated as a param value (e.g. a company slug) rather than a route
// word, per this function's own header comment.
const STATIC_SEGMENTS = new Set([
  "api",
  "v1",
  "signals",
  "signals.csv",
  "companies",
  "sources",
  "facets",
  "export",
  "trends",
  "admin",
  "feed.rss",
  "health",
  "timeline",
  "hiring",
  "run",
  "scheduler",
  "flush",
  "reconcile",
]);

export function normalizeRoutePath(pathname: string): string {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const normalized = segments.map((segment) => {
    if (UUID_RE.test(segment)) return ":id";
    if (!STATIC_SEGMENTS.has(segment)) return ":param";
    return segment;
  });
  return `/${normalized.join("/")}`;
}
