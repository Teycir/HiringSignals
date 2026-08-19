import { computeAcceleration } from "@hiring-signals/domain";
import type { RoleCategory, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import type { HiringTrendCompany } from "./types";

// Re-exported from types.ts (not defined here) so apps/cli can import
// this shape without pulling in D1Client -- see types.ts's own header
// comment and this interface's comment there for the full reasoning.
export type { HiringTrendCompany } from "./types";

/**
 * Cross-company hiring trend endpoint (ROADMAP.md Milestone P.2, spec
 * §1.2/§2.3). Ranks companies by recent hiring activity for a given set
 * of role categories -- "which fintechs started hiring ML in the last
 * 60d," not a single-company view (that's O.1's getCompanyHiringTimeline).
 *
 * Two round trips, same reasoning as getCompanyHiringTimeline's own
 * header comment: one query aggregates job counts (new/active/n14/n56/
 * top locations) grouped by company, the other resolves each company's
 * single latest signal (type + timestamp). Folding both into one query
 * would need a correlated subquery or a second join per company just
 * for the "latest signal" pick, which is exactly as easy to express as
 * a separate query and keeps each query's own EXPLAIN QUERY PLAN
 * legible against idx_jobs_trends (migration 0007) independently.
 */

/**
 * Query 1's raw per-company aggregation row shape -- extracted to a
 * named type (rather than inline in the client.all<...>() call) so
 * sortRowsBySort below can accept/return this exact same full shape
 * instead of a hand-picked field subset, which previously caused
 * `rankedRows` to widen to a narrower inferred type and drop
 * company_slug/company_display_name/etc (TS2339 at the results.map
 * below) -- see sortRowsBySort's own comment.
 */
interface TrendRow {
  company_id: string;
  company_slug: string;
  company_display_name: string;
  company_industry: string | null;
  company_domain: string | null;
  hiring_velocity_score: number | null;
  new_jobs_count: number;
  active_jobs_count: number;
  n14: number;
  n56: number;
}

export interface GetHiringTrendsParams {
  roleCategoryFilter: RoleCategory[];
  industryFilter?: string;
  countryFilter?: string;
  since: string;
  limit: number;
  sort: "acceleration_desc" | "volume_desc" | "velocity_desc";
}

/**
 * `since` anchors both the "new jobs in this window" count and the n14/
 * n56 acceleration inputs -- n14 is always the most recent 14 days
 * ending now (matching computeAcceleration's own spec §7.2 semantics,
 * same anchor company-role-stats-repo.ts's getCompanyRoleActivityStats
 * uses), independent of the caller's `since` filter, which instead
 * bounds `newJobsCount`/`activeJobsCount`/`topLocations`. A caller
 * asking for `since=90d` still gets an acceleration figure computed on
 * the standard 14-vs-56-day window, not a window stretched to match
 * their custom `since` -- acceleration is a fixed-definition metric,
 * not a caller-adjustable one, same as every other computeAcceleration
 * call site in this codebase.
 */
export async function getHiringTrends(
  client: D1Client,
  params: GetHiringTrendsParams,
): Promise<HiringTrendCompany[]> {
  const { roleCategoryFilter, industryFilter, countryFilter, since, limit, sort } = params;
  const now = new Date().toISOString();

  const roleFragment = `role_primary IN (${roleCategoryFilter.map(() => "?").join(",")})`;
  const industryFragment = industryFilter ? "AND c.industry = ?" : "";
  const countryFragment = countryFilter ? "AND j.country_code = ?" : "";

  const baseParams: unknown[] = [...roleCategoryFilter];
  if (industryFilter) baseParams.push(industryFilter);
  if (countryFilter) baseParams.push(countryFilter);

  // n14/n56/activeJobsCount/newJobsCount/topLocations all read from the
  // same jobs rows per company -- one query with conditional aggregation
  // (SUM(CASE WHEN ...)), same pattern as getCompanyRoleActivityStats,
  // rather than five separate per-company queries.
  const rows = await client.all<TrendRow>(
    `SELECT
       c.id AS company_id,
       c.slug AS company_slug,
       c.display_name AS company_display_name,
       c.industry AS company_industry,
       c.domain AS company_domain,
       c.hiring_velocity_score AS hiring_velocity_score,
       SUM(CASE WHEN j.first_seen_at >= ? THEN 1 ELSE 0 END) AS new_jobs_count,
       SUM(CASE WHEN j.status IN ('active', 'possibly_closed') THEN 1 ELSE 0 END) AS active_jobs_count,
       SUM(CASE WHEN j.first_seen_at >= datetime(?, '-14 days') AND j.first_seen_at <= ?
                THEN 1 ELSE 0 END) AS n14,
       SUM(CASE WHEN j.first_seen_at >= datetime(?, '-70 days')
                 AND j.first_seen_at < datetime(?, '-14 days')
                THEN 1 ELSE 0 END) AS n56
     FROM jobs j
     JOIN companies c ON c.id = j.company_id
     WHERE ${roleFragment} ${industryFragment} ${countryFragment}
     GROUP BY c.id
     HAVING new_jobs_count > 0`,
    // Param order must match the SQL's own textual ? order, not the
    // order values are logically grouped in code: the SELECT list's 5
    // placeholders (new_jobs_count's since, then n14/n56's 4 nows) all
    // appear before the WHERE clause's roleFragment/industryFragment/
    // countryFragment placeholders (baseParams) in the query text above
    // -- baseParams must come LAST here, not right after since. Fixed
    // 2026-08-12: this was previously [since, ...baseParams, now, now,
    // now, now], which put baseParams in positions 2..N, silently
    // binding role/industry/country values into the n14/n56 datetime()
    // calls and pushing the trailing `now`s into roleFragment's WHERE
    // placeholder(s) instead -- SQLite does not error on this (a string
    // bound where a date-ish value was expected just fails the range
    // comparison silently), so the query always returned 0 rows without
    // ever throwing. Caught via direct instrumentation: a manually
    // reproduced query using the correct param order returned the
    // expected rows against the same live data this one returned zero
    // for.
    [since, now, now, now, now, ...baseParams],
  );


  // Perf fix (2026-08-12): the two follow-up queries below used to fan
  // out over EVERY row query 1 returned (every company matching the
  // role/industry/country filter, live-table-wide), then sort+slice to
  // `limit` only at the very end -- so `limit` never actually bounded
  // the expensive part. At production data volume this made
  // getTopLocationsByCompany/getLatestSignalByCompany's own IN (...)
  // clauses balloon to hundreds of company_ids regardless of how small
  // `limit` was, which is what pushed trends-repo.test.ts past even a
  // 240s per-test timeout once TEST_LIMIT (2026-08-12, see that
  // constant's own comment) stopped capping query 1's effective fan-out
  // early. Fix: rank+slice on `rows` directly first (acceleration/
  // newJobsCount/hiringVelocityScore are all already present on `rows`,
  // no enrichment needed), THEN only fan queries 2/3 out over that
  // `limit`-sized slice.
  const rankedRows = sortRowsBySort(rows, sort).slice(0, limit);
  const companyIdsForFanout = rankedRows.map((r) => r.company_id);

  const topLocationsByCompany = await getTopLocationsByCompany(client, {
    roleCategoryFilter,
    industryFilter,
    countryFilter,
    since,
    companyIds: companyIdsForFanout,
  });

  const latestSignalByCompany = await getLatestSignalByCompany(client, companyIdsForFanout);

  const results: HiringTrendCompany[] = rankedRows.map((row) => {
    const latest = latestSignalByCompany.get(row.company_id);
    return {
      company: {
        slug: row.company_slug,
        displayName: row.company_display_name,
        industry: row.company_industry,
        domain: row.company_domain,
      },
      newJobsCount: row.new_jobs_count,
      activeJobsCount: row.active_jobs_count,
      acceleration: computeAcceleration(row.n14, row.n56),
      topLocations: topLocationsByCompany.get(row.company_id) ?? [],
      latestSignalType: latest?.signalType ?? null,
      latestSignalAt: latest?.detectedAt ?? null,
      hiringVelocityScore: row.hiring_velocity_score,
    };
  });

  // `newest_signal` still needs the general sortTrends path (its sort
  // key, latestSignalAt, only exists on `results` post-enrichment) --
  // every other sort was already applied to `rows` above, so re-sorting
  // `results` here is a cheap no-op re-derivation of the same order,
  // kept only so the function has one single return path/shape.
  return sortTrends(results, sort).slice(0, limit);
}

/**
 * Same ranking `sortTrends` applies, but operating directly on query 1's
 * raw aggregated rows instead of the fully-enriched HiringTrendCompany[]
 * -- lets the caller rank+slice BEFORE paying for the topLocations/
 * latestSignal fan-out queries. Supports all three sorts (acceleration,
 * new_jobs_count, hiring_velocity_score) whose key is already present
 * on `rows`.
 */
function sortRowsBySort(rows: TrendRow[], sort: GetHiringTrendsParams["sort"]): TrendRow[] {
  const sorted = [...rows];
  if (sort === "volume_desc") {
    sorted.sort((a, b) => b.new_jobs_count - a.new_jobs_count);
  } else if (sort === "velocity_desc") {
    sorted.sort((a, b) => {
      if (a.hiring_velocity_score === null && b.hiring_velocity_score === null) return 0;
      if (a.hiring_velocity_score === null) return 1;
      if (b.hiring_velocity_score === null) return -1;
      return b.hiring_velocity_score - a.hiring_velocity_score;
    });
  } else {
    sorted.sort((a, b) => computeAcceleration(b.n14, b.n56) - computeAcceleration(a.n14, a.n56));
  }
  return sorted;
}

function sortTrends(
  results: HiringTrendCompany[],
  sort: GetHiringTrendsParams["sort"],
): HiringTrendCompany[] {
  const sorted = [...results];
  if (sort === "volume_desc") {
    sorted.sort((a, b) => b.newJobsCount - a.newJobsCount);
  } else if (sort === "velocity_desc") {
    // Null-sorts-last convention -- a company whose velocity score hasn't
    // been computed yet (Q.2's handleVelocityRecompute hasn't run for it)
    // is not "0 velocity," it's unknown, so it shouldn't outrank or be
    // conflated with a genuinely low-velocity company.
    sorted.sort((a, b) => {
      if (a.hiringVelocityScore === null && b.hiringVelocityScore === null) return 0;
      if (a.hiringVelocityScore === null) return 1;
      if (b.hiringVelocityScore === null) return -1;
      return b.hiringVelocityScore - a.hiringVelocityScore;
    });
  } else {
    sorted.sort((a, b) => b.acceleration - a.acceleration);
  }
  return sorted;
}

const TOP_N_LOCATIONS = 5;

/**
 * Top-N countries per company among matching jobs, split into its own
 * function/query rather than folded into the main aggregation above --
 * a per-company Top-N requires a second grouping dimension
 * (company_id, country_code) that the main query's single-row-per-
 * company GROUP BY c.id can't also produce without either a window
 * function (D1/SQLite version support for this is not something this
 * codebase relies on elsewhere -- see getCompanyHiringTimeline's own
 * "computed once, in code" precedent) or string concatenation. Reduced
 * to top 5 in code, same pattern as getCompanyHiringTimeline's
 * roleBreakdown/locationBreakdown.
 */
async function getTopLocationsByCompany(
  client: D1Client,
  params: {
    roleCategoryFilter: RoleCategory[];
    industryFilter?: string;
    countryFilter?: string;
    since: string;
    companyIds: string[];
  },
): Promise<Map<string, Array<{ countryCode: string | null; count: number }>>> {
  const result = new Map<string, Array<{ countryCode: string | null; count: number }>>();
  if (params.companyIds.length === 0) return result;

  const roleFragment = `role_primary IN (${params.roleCategoryFilter.map(() => "?").join(",")})`;
  const industryFragment = params.industryFilter ? "AND c.industry = ?" : "";
  const countryFragment = params.countryFilter ? "AND j.country_code = ?" : "";
  const companyFragment = `c.id IN (${params.companyIds.map(() => "?").join(",")})`;

  const queryParams: unknown[] = [...params.roleCategoryFilter];
  if (params.industryFilter) queryParams.push(params.industryFilter);
  if (params.countryFilter) queryParams.push(params.countryFilter);
  queryParams.push(params.since, ...params.companyIds);

  const rows = await client.all<{ company_id: string; country_code: string | null; count: number }>(
    `SELECT c.id AS company_id, j.country_code AS country_code, COUNT(*) AS count
     FROM jobs j
     JOIN companies c ON c.id = j.company_id
     WHERE ${roleFragment} ${industryFragment} ${countryFragment}
       AND j.first_seen_at >= ? AND ${companyFragment}
     GROUP BY c.id, j.country_code
     ORDER BY count DESC`,
    queryParams,
  );

  for (const row of rows) {
    const existing = result.get(row.company_id) ?? [];
    if (existing.length < TOP_N_LOCATIONS) {
      existing.push({ countryCode: row.country_code, count: row.count });
    }
    result.set(row.company_id, existing);
  }
  return result;
}

/**
 * Single latest active signal per company (any role/type -- P.2's
 * response shape is one `latestSignalType`/`latestSignalAt` pair per
 * company, not a per-role breakdown). idx_signals_feed (migration 0001)
 * covers (status, role_category, score DESC, last_detected_at DESC) --
 * no company_id, so this can't use that index for a per-company lookup;
 * acceptable here since it's bounded to the same small `companyIds` set
 * the main query already narrowed down to, not a scan of the whole
 * signals table.
 */
async function getLatestSignalByCompany(
  client: D1Client,
  companyIds: string[],
): Promise<Map<string, { signalType: SignalType; detectedAt: string }>> {
  const result = new Map<string, { signalType: SignalType; detectedAt: string }>();
  if (companyIds.length === 0) return result;

  const rows = await client.all<{ company_id: string; signal_type: SignalType; first_detected_at: string }>(
    `SELECT company_id, signal_type, first_detected_at
     FROM signals
     WHERE company_id IN (${companyIds.map(() => "?").join(",")}) AND status = 'active'
     ORDER BY company_id, first_detected_at DESC`,
    companyIds,
  );

  for (const row of rows) {
    if (!result.has(row.company_id)) {
      result.set(row.company_id, { signalType: row.signal_type, detectedAt: row.first_detected_at });
    }
  }
  return result;
}
