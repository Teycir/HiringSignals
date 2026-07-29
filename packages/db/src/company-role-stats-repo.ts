import type { RoleCategory } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";

/**
 * Shared company+role activity stats (ROADMAP.md Milestone H.2, spec
 * §7.2). Foundation for H.3 (real V/A/B scoring) and H.4 (company-level
 * signal generation) -- both need "how much matching activity does this
 * company+role have right now," so it's computed once, in one query,
 * rather than duplicated across the scoring path and the signal-
 * generation path.
 */

export interface CompanyRoleActivityStats {
  /** Count of status IN ('active', 'possibly_closed') jobs for
   * (company_id, role_primary) -- feeds V (volume). */
  activeMatchingCount: number;
  /** Count of jobs whose first_seen_at falls in the most-recent-14-days
   * window, same (company_id, role_primary) -- feeds A (acceleration),
   * spec §7.2's N_14. */
  newInLast14Days: number;
  /** Count of jobs whose first_seen_at falls in the 56-day window
   * immediately preceding the 14-day window above -- feeds A, spec
   * §7.2's N_56. */
  newInPrior56Days: number;
  /** Count of distinct (country_code, region_code, city, location_mode)
   * tuples among currently-active matching jobs -- feeds B (breadth),
   * and is also the exact quantity multi_location's trigger threshold
   * (H.4) checks against. */
  distinctLocationCount: number;
}

/**
 * Anchored on `first_seen_at` (our own first-observation timestamp), not
 * `posted_at` -- this is specifically counting "new matching role"
 * *detection* events, which is what `first_seen_at` represents by
 * construction (see lifecycle.ts's computeLifecycleTransition `new_job`
 * branch). `posted_at` is a different concept (see H.5's freshness-anchor
 * work) and using it here would conflate two already-distinct things
 * under one anchor.
 *
 * `now` is passed in by the caller rather than computed via SQLite's
 * `datetime('now')` so the 14/56-day windows are anchored on the same
 * `observedAt` the rest of the ingest-consumer pipeline uses for a given
 * run -- keeps this function pure/deterministic and testable without
 * depending on the database's own clock.
 *
 * Single round trip via one SELECT with conditional aggregation
 * (`SUM(CASE WHEN ... THEN 1 ELSE 0 END)`), not four separate queries --
 * all four stats read from the same `jobs` rows for this (company_id,
 * role_primary) pair, so there's no reason to hit D1 more than once.
 *
 * distinctLocationCount only considers currently-active matching jobs
 * (`status IN ('active', 'possibly_closed')`), same population as
 * activeMatchingCount -- a closed job's location shouldn't count toward
 * "how many places is this company hiring for this role right now."
 *
 * Empty-result case (no jobs yet for this company+role): every field
 * returns 0, never null/undefined -- callers (H.3's scoring, H.4's
 * signal triggers) can use the result directly without a null check.
 */
export async function getCompanyRoleActivityStats(
  client: D1Client,
  params: { companyId: string; roleCategory: RoleCategory; now: string },
): Promise<CompanyRoleActivityStats> {
  const row = await client.first<{
    active_matching_count: number;
    new_in_last_14_days: number;
    new_in_prior_56_days: number;
    distinct_location_count: number;
  }>(
    `SELECT
       SUM(CASE WHEN status IN ('active', 'possibly_closed') THEN 1 ELSE 0 END)
         AS active_matching_count,
       SUM(CASE WHEN first_seen_at >= datetime(?, '-14 days') AND first_seen_at <= ?
                THEN 1 ELSE 0 END) AS new_in_last_14_days,
       SUM(CASE WHEN first_seen_at >= datetime(?, '-70 days')
                 AND first_seen_at < datetime(?, '-14 days')
                THEN 1 ELSE 0 END) AS new_in_prior_56_days,
       COUNT(DISTINCT CASE WHEN status IN ('active', 'possibly_closed')
                THEN country_code || '::' || region_code || '::' || city || '::' || location_mode
                ELSE NULL END) AS distinct_location_count
     FROM jobs
     WHERE company_id = ? AND role_primary = ?`,
    [params.now, params.now, params.now, params.now, params.companyId, params.roleCategory],
  );

  return {
    activeMatchingCount: row?.active_matching_count ?? 0,
    newInLast14Days: row?.new_in_last_14_days ?? 0,
    newInPrior56Days: row?.new_in_prior_56_days ?? 0,
    distinctLocationCount: row?.distinct_location_count ?? 0,
  };
}
