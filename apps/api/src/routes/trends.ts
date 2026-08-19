import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createD1Client, getHiringTrends } from "@hiring-signals/db";
import { HIRING_VELOCITY_DISCLAIMER, trendsQuerySchema } from "@hiring-signals/domain";
import { freeReadTier } from "../middleware/anti-abuse";

const CACHE_TTL_SECONDS = 300;

/**
 * Cross-company hiring trend endpoint (ROADMAP.md Milestone P.2, spec
 * §1.2/§2.3). "Which fintechs started hiring ML in the last 60d" --
 * ranked companies, not a single-company timeline (that's O.1).
 *
 * 5-min TTL KV cache, same pattern as facets.ts -- cache key includes
 * every param that affects the result (roles/industry/country/since/
 * sort/limit) since two different param combinations must never share
 * a cache entry. `since` defaults here (7d-ago), not in
 * trendsQuerySchema itself, same "now at schema-load time would be
 * stale" reasoning as companyTimelineQuerySchema's own header comment.
 *
 * 7 days, not 30 (changed 2026-08-19): trends-table.tsx shows this
 * window's new_jobs_count next to trends-repo.ts's activeJobsCount
 * (status IN ('active','possibly_closed'), no date bound at all) in
 * adjacent NEW/ACTIVE columns. With a 30-day window, every currently-
 * active job for every company was indistinguishable from "new" for
 * this dataset's entire life so far (ingestion started 2026-07-26 --
 * confirmed live via `SELECT MIN(first_seen_at) FROM jobs`, and
 * `active_older_than_30d` was 0 across all 6,779 rows checked the same
 * way), so NEW and ACTIVE rendered identical on every row -- not a
 * query bug (the two columns measure genuinely different things), just
 * a default wide enough to make them coincide for a dataset this young.
 * 7 days is a standard "new this week" window that will diverge from
 * ACTIVE almost immediately regardless of dataset age, since it's very
 * unlikely every active job across every company was posted in the
 * last 7 days specifically.
 */
const DEFAULT_SINCE_DAYS = 7;

/**
 * Resolves the `since` default (7d-ago at request time, not schema-load
 * time), pulled out of the route handler as a pure function so it's
 * directly unit-testable without a live D1/KV binding -- same
 * "resolveTimelineWindow" precedent companies.ts's own header comment
 * establishes for O.1. Unlike O.1's window, P.2 has no upper-bound cap
 * to validate (spec doesn't specify one for trends `since`), so this
 * only defaults -- it never rejects.
 */
export function resolveTrendsSince(parsed: { since?: string }, now: Date = new Date()): string {
  return parsed.since ?? new Date(now.getTime() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Cache key must include every param that affects the result (see this
 * file's own top header comment) -- pulled out alongside
 * resolveTrendsSince so both pieces of the route's non-pass-through
 * logic are unit-tested the same way, not just the since-default half.
 */
export function buildTrendsCacheKey(parsed: object, since: string): string {
  return `trends:v1:${JSON.stringify({ ...parsed, since })}`;
}

export const trendsRoute = new Hono<AppEnv>();
trendsRoute.use("*", freeReadTier());

trendsRoute.get("/hiring", async (c) => {
  const parsed = trendsQuerySchema.parse(c.req.query());
  const since = resolveTrendsSince(parsed);

  const cacheKey = buildTrendsCacheKey(parsed, since);
  const cached = await c.env.CACHE.get(cacheKey, "json");
  if (cached) {
    return c.json({
      data: cached,
      meta: {
        requestId: c.get("requestId"),
        appliedFilters: { ...parsed, since },
        cached: true,
        hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
      },
    });
  }

  const client = createD1Client(c.env.DB);
  const results = await getHiringTrends(client, {
    roleCategoryFilter: parsed.roles,
    industryFilter: parsed.industry,
    countryFilter: parsed.country,
    since,
    limit: parsed.limit,
    sort: parsed.sort,
  });

  await c.env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: CACHE_TTL_SECONDS });

  return c.json({
    data: results,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: { ...parsed, since },
      cached: false,
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
    },
  });
});
