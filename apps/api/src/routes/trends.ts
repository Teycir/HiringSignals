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

/**
 * "Last known good" fallback key, separate from buildTrendsCacheKey's
 * 5-min TTL hot-cache key (2026-09-02, D1 free-tier exhaustion
 * incident). Deliberately a different KV key, not a longer TTL on the
 * existing one: the hot cache's whole purpose is "expire quickly so
 * results stay fresh," and giving it a long TTL to double as a fallback
 * would mean serving stale data on every cache hit within that window,
 * not just when D1 is genuinely unreachable. This key is written
 * alongside the hot-cache key on every successful D1 fetch (see below)
 * with no expirationTtl, so it survives independently of the 300s hot
 * cache and is only ever overwritten by a fresher successful fetch --
 * never read on the happy path, only as a fallback when D1 itself
 * throws (exhausted daily row-read quota, outage, etc.) and there is no
 * fresh data available at all.
 */
export function buildTrendsFallbackCacheKey(parsed: object, since: string): string {
  return `trends:fallback:v1:${JSON.stringify({ ...parsed, since })}`;
}

interface StaleTrendsPayload {
  results: unknown;
  fetchedAt: string;
}

export const trendsRoute = new Hono<AppEnv>();
trendsRoute.use("*", freeReadTier());

trendsRoute.get("/hiring", async (c) => {
  const parsed = trendsQuerySchema.parse(c.req.query());
  const since = resolveTrendsSince(parsed);

  const cacheKey = buildTrendsCacheKey(parsed, since);

  // Cache read with graceful fallback (2026-09-02 prod incident, same
  // KV-quota/transient-error reasoning as the .put() below, which this
  // .get() call was missed by in the 2026-08-19 fix -- an unguarded
  // read throw here skipped straight to D1 in dev/low-traffic testing
  // (cache almost always a miss locally) but crashed the whole request
  // in production once a warm cache made this the hot path on every
  // request. Falls through to the fresh-D1-query path below on any KV
  // read failure, same as a genuine cache miss -- correctness is
  // unaffected, just a lost cache hit.
  let cached: unknown = null;
  try {
    cached = await c.env.CACHE.get(cacheKey, "json");
  } catch (err) {
    console.error(`KV cache read failed for key ${cacheKey}:`, err);
  }
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

  const fallbackCacheKey = buildTrendsFallbackCacheKey(parsed, since);
  const client = createD1Client(c.env.DB);

  // D1-outage fallback (2026-09-02 incident): getHiringTrends throws
  // when D1 itself is unreachable -- most commonly the free tier's
  // daily row-read quota (D1_ERROR code 7500), which resets at midnight
  // UTC but can otherwise leave every /trends request 500ing for hours.
  // Per-route "get latest working data if there's no way to fetch new
  // data" policy: on a D1 failure, fall back to the last successful
  // result for this exact param combination (buildTrendsFallbackCacheKey)
  // rather than failing the request outright. Only when there is no
  // fallback available either (first-ever request for this filter
  // combo, or a KV outage on top of the D1 outage) does this rethrow
  // and let errorHandler's generic 500 apply -- there is genuinely
  // nothing to serve at that point.
  let results: unknown;
  let stale: { fetchedAt: string } | null = null;
  try {
    results = await getHiringTrends(client, {
      roleCategoryFilter: parsed.roles,
      industryFilter: parsed.industry,
      countryFilter: parsed.country,
      since,
      limit: parsed.limit,
      sort: parsed.sort,
    });
  } catch (err) {
    console.error(`D1 query failed for trends (falling back to last known good):`, err);

    let fallback: StaleTrendsPayload | null = null;
    try {
      fallback = await c.env.CACHE.get<StaleTrendsPayload>(fallbackCacheKey, "json");
    } catch (kvErr) {
      console.error(`KV fallback read failed for key ${fallbackCacheKey}:`, kvErr);
    }

    if (!fallback) throw err;

    results = fallback.results;
    stale = { fetchedAt: fallback.fetchedAt };
  }

  // Cache writes with graceful fallback for KV quota limits (free tier
  // has a daily write limit) -- if exceeded, still return the fresh
  // result rather than failing the entire request. Only written on the
  // success path above (stale === null): a served-stale response must
  // never overwrite the fallback key with the same stale payload it was
  // just read from, and must never refresh the 300s hot-cache TTL on
  // data that is, by definition, not fresh.
  if (!stale) {
    const fetchedAt = new Date().toISOString();
    try {
      await c.env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (err) {
      console.error(`KV cache write failed for key ${cacheKey}:`, err);
    }
    try {
      await c.env.CACHE.put(
        fallbackCacheKey,
        JSON.stringify({ results, fetchedAt } satisfies StaleTrendsPayload),
      );
    } catch (err) {
      console.error(`KV fallback write failed for key ${fallbackCacheKey}:`, err);
    }
  }

  return c.json({
    data: results,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: { ...parsed, since },
      cached: false,
      stale: stale !== null,
      staleAsOf: stale?.fetchedAt ?? null,
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
    },
  });
});
