import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createD1Client, readTrendsSnapshots, readTrendsSnapshotsMirror } from "@hiring-signals/db";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";
import { HIRING_VELOCITY_DISCLAIMER, type RoleCategory, trendsQuerySchema } from "@hiring-signals/domain";
import { freeReadTier } from "../middleware/anti-abuse";

/**
 * Cross-company hiring trend endpoint (ROADMAP.md Milestone P.2, spec
 * §1.2/§2.3). "Which fintechs started hiring ML in the last 60d" --
 * ranked companies, not a single-company timeline (that's O.1).
 *
 * Rewritten (snapshot-persistence-plan.md) to read exclusively from
 * snapshots_current (domain="trends", one row per RoleCategory) instead
 * of a live jobs/companies JOIN plus a KV cache/fallback pair. The KV
 * "last known good" fallback added 2026-09-02 was keyed per exact
 * filter-parameter combination, so any new/uncommon filter combo had no
 * fallback entry and still 500'd on a D1 outage -- a structural gap,
 * not a bug fixable by tuning that cache further. This route no longer
 * touches `jobs`/`companies` at all: the daily reconciliation cron
 * (apps/api/src/jobs/reconciliation.ts's handleSnapshotCapture) is the
 * only place that computes fresh trend data, once a day, off request
 * traffic entirely. If that capture step fails or hasn't run yet since
 * the last successful one, snapshots_current for a given role is simply
 * whatever the last successful capture wrote -- served indefinitely,
 * with no TTL/expiry/"stale" concept, per lib/d1/snapshot-store.ts's
 * design.
 *
 * `since`/`sort`/`limit`/`industry`/`country` remain accepted query
 * params (trendsQuerySchema, @hiring-signals/domain) for backward
 * compatibility with existing callers (apps/web, apps/cli), but they now
 * apply to the SNAPSHOT rows in-process rather than shaping a live SQL
 * query -- `since` in particular is no longer meaningful (the snapshot's
 * own `newJobsCount`/`acceleration` were computed with a fixed 7-day
 * window at capture time, see reconciliation.ts's handleSnapshotCapture)
 * and is accepted-but-ignored rather than rejected, so an existing
 * caller passing it doesn't get a 400.
 *
 * Deliberately snapshot-first, never live, unlike signals.ts (which
 * tries a live D1 query before falling back to its own snapshot). See
 * signals.ts's header comment for the full cost/fidelity comparison --
 * short version: getHiringTrends (trends-repo.ts) scans every `jobs`
 * row for the requested roles before `limit` ever applies, which is the
 * unbounded query that exhausted the D1 free-tier quota in the first
 * place, whereas this route's own `since`/7-day-window semantics are
 * already daily-granularity by design -- so reading the snapshot by
 * default costs no fidelity here the way it would on signals.ts. Same
 * D1-snapshot -> KV-mirror fallback shape as signals.ts either way.
 */
export const trendsRoute = new Hono<AppEnv>();
trendsRoute.use("*", freeReadTier());

trendsRoute.get("/hiring", async (c) => {
  const parsed = trendsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  // D1-outage guard on the snapshot read itself (2026-09-03 prod
  // incident): the snapshot-persistence-plan.md rewrite moved this
  // route off the live jobs/companies JOIN specifically so read traffic
  // could never hit the D1 daily-row-read quota wall ingestion is
  // subject to -- but readTrendsSnapshots() is still a D1 query against
  // snapshots_current, and a bare account-wide quota exhaustion (not
  // just a live-table-sized query) can still throw here, same as it
  // can for any other D1 call. On failure, this now falls back to a KV
  // mirror of the same snapshot data (written alongside the D1 row on
  // every successful daily capture, see reconciliation.ts's
  // handleSnapshotCapture) -- KV has its own quota, entirely separate
  // from D1's, so trends stays servable from the last known-good
  // capture even during a full D1 outage, not just a smaller D1 query.
  // Only genuinely empty (degraded: true, no data) when BOTH D1 and the
  // KV mirror are unreachable for a requested role -- e.g. reconciliation
  // has never run since deploy, or KV itself is also down.
  let snapshotsByRole: Map<string, { payload: { companies: HiringTrendCompany[] }; capturedAt: string }>;
  let degraded = false;
  try {
    snapshotsByRole = await readTrendsSnapshots(client, {
      roleCategories: parsed.roles,
    });
  } catch (err) {
    console.error("D1 query failed for trends snapshot read, falling back to KV mirror:", err);
    try {
      snapshotsByRole = await readTrendsSnapshotsMirror(c.env.CACHE, {
        roleCategories: parsed.roles as RoleCategory[],
      });
    } catch (kvErr) {
      // readTrendsSnapshotsMirror itself never throws (best-effort
      // internally, lib/kv/snapshot-mirror.ts) -- this catch exists
      // only as a defensive backstop, not an expected path.
      console.error("KV mirror read also failed for trends:", kvErr);
      snapshotsByRole = new Map();
    }
    // degraded reflects whether we still ended up with nothing at all
    // for every requested role, not merely whether D1 itself failed --
    // a successful KV fallback is a full recovery from the caller's
    // point of view (real data, just via a different path), so it
    // should not be flagged as degraded the same way a genuine
    // both-paths-failed outcome is.
    degraded = snapshotsByRole.size === 0;
  }

  const merged = mergeTrendSnapshots(snapshotsByRole, {
    industryFilter: parsed.industry,
    countryFilter: parsed.country,
  });

  const sorted = sortTrendCompanies(merged, parsed.sort).slice(0, parsed.limit);

  // A role_category with no snapshot row yet (reconciliation hasn't run
  // since deploy, or genuinely no companies matched that role at last
  // capture) has no capturedAt to report -- only meaningful once at
  // least one requested role has a snapshot.
  const capturedAts = parsed.roles
    .map((role) => snapshotsByRole.get(role)?.capturedAt)
    .filter((ts): ts is string => ts !== undefined);
  const oldestCapturedAt = capturedAts.length > 0 ? capturedAts.sort()[0] : null;

  return c.json({
    data: sorted,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      // No live/cached distinction anymore -- every response is served
      // from the snapshot store. capturedAt (renamed from the old
      // cached/stale/staleAsOf trio) tells the caller how fresh this
      // is: the oldest capture time among the requested roles, since a
      // multi-role request can mix roles captured at slightly different
      // times if reconciliation partially failed on a prior run (see
      // handleSnapshotCapture's per-role try/catch).
      snapshotCapturedAt: oldestCapturedAt,
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
      // True only when the snapshot read itself failed this request
      // (see the try/catch above) -- distinct from "no data yet"
      // (reconciliation hasn't run since deploy), which reports
      // degraded: false with an empty `data` array and
      // snapshotCapturedAt: null. Lets callers tell "temporarily
      // degraded, try again shortly" apart from "genuinely nothing
      // captured yet" without guessing from an empty array alone.
      degraded,
    },
  });
});

/**
 * A company can appear in more than one requested role's snapshot (a
 * company hiring both cybersecurity and cloud/devops shows up under
 * both role_category snapshot rows). Dedupe by company slug, keeping
 * whichever row has the higher newJobsCount for that company -- an
 * arbitrary but deterministic tie-break; a multi-role request's ranking
 * is across companies, not roles, so which single row represents a
 * multi-role company doesn't change the set of companies shown, only
 * which one of its per-role metric snapshots backs the displayed
 * numbers.
 *
 * industryFilter/countryFilter are applied here, in-process, against
 * each row's own denormalized company.industry / topLocations fields --
 * captured at snapshot time (reconciliation.ts's handleSnapshotCapture),
 * not re-queried from `companies`/`jobs` live. A countryFilter matches
 * if the country appears anywhere in that row's topLocations (the same
 * top-N-per-company shape trends-repo.ts always returned; there is no
 * per-country job count preserved beyond that top-N list).
 */
export function mergeTrendSnapshots(
  snapshotsByRole: Map<string, { payload: { companies: HiringTrendCompany[] }; capturedAt: string }>,
  filters: { industryFilter?: string; countryFilter?: string },
): HiringTrendCompany[] {
  const bySlug = new Map<string, HiringTrendCompany>();

  for (const { payload } of snapshotsByRole.values()) {
    for (const row of payload.companies) {
      if (filters.industryFilter && row.company.industry !== filters.industryFilter) {
        continue;
      }
      if (
        filters.countryFilter &&
        !row.topLocations.some((loc) => loc.countryCode === filters.countryFilter)
      ) {
        continue;
      }

      const existing = bySlug.get(row.company.slug);
      if (!existing || row.newJobsCount > existing.newJobsCount) {
        bySlug.set(row.company.slug, row);
      }
    }
  }

  return [...bySlug.values()];
}

/**
 * Same ranking semantics the old trends-repo.ts's sortTrends applied,
 * moved here since sorting now happens over merged snapshot rows in the
 * route rather than freshly queried D1 rows in the repo.
 */
export function sortTrendCompanies(
  results: HiringTrendCompany[],
  sort: "acceleration_desc" | "volume_desc" | "velocity_desc",
): HiringTrendCompany[] {
  const sorted = [...results];
  if (sort === "volume_desc") {
    sorted.sort((a, b) => b.newJobsCount - a.newJobsCount);
  } else if (sort === "velocity_desc") {
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
