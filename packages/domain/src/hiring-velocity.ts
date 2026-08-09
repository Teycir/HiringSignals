/**
 * Hiring velocity score computation (ROADMAP.md Milestone Q.1, spec's
 * investor-audience extension beyond §7.2). Pure function, no D1 --
 * same reasoning as signal-score.ts's own header comment: a
 * company-level score needs to be independently recomputable and
 * unit-testable from persisted stats, not buried inside a route or
 * cron handler.
 *
 * Distinct question from signal-score.ts's per-signal score: that
 * ranks one role-level signal's freshness/volume/acceleration/breadth/
 * quality. This ranks a company's *overall* hiring aggressiveness
 * across every role category, for the investor/analyst use case
 * Milestone P's trends endpoint already serves ("which fintechs
 * started hiring ML in the last 60d" -> "how aggressively is Acme
 * building its team right now").
 */
import { computeAcceleration, computeBreadth } from "./signal-score";

export const VELOCITY_FORMULA_VERSION = "v1";

/**
 * ROADMAP.md Milestone Q.3, spec §11.3's exact disclaimer wording.
 * Exported as a shared constant (not duplicated as a literal in each
 * route) so `GET /api/v1/trends/hiring` and `GET /api/v1/companies/:slug`
 * carry byte-identical text -- spec §11.3 calls for the same disclaimer
 * in both places, not two independently-maintained copies that could
 * drift.
 */
export const HIRING_VELOCITY_DISCLAIMER =
  "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.";

// Weights sum to 1.0 (ROADMAP.md Q.1's own formula):
// V = clamp(0.40*acceleration + 0.25*breadth + 0.20*volume_norm + 0.15*persistence, 0, 1) * 100
const WEIGHT_ACCELERATION = 0.4;
const WEIGHT_BREADTH = 0.25;
const WEIGHT_VOLUME = 0.2;
const WEIGHT_PERSISTENCE = 0.15;
const SCORE_MAX = 100;

// volume_norm = clamp(totalActiveJobs / 10, 0, 1) -- 10 is a documented
// v1 choice (ROADMAP.md Q.1), same "revisit once real ingestion volume
// shows what 'high' looks like" caveat signal-score.ts's own
// VOLUME_SCALE carries for the per-signal case.
const VOLUME_NORM_SCALE = 10;

// persistence = clamp(daysSinceFirstSignal / 30, 0, 1) -- 30 days is
// ROADMAP.md Q.1's own threshold: a company with a signal history
// spanning a month or more is treated as having established, not
// just momentary, hiring activity.
const PERSISTENCE_SCALE_DAYS = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** volume_norm: total active matching jobs across all roles, normalized. */
export function computeVolumeNorm(totalActiveJobs: number): number {
  return clamp(totalActiveJobs / VOLUME_NORM_SCALE, 0, 1);
}

/** persistence: how long this company has had at least one signal. */
export function computePersistence(daysSinceFirstSignal: number): number {
  return clamp(daysSinceFirstSignal / PERSISTENCE_SCALE_DAYS, 0, 1);
}

export interface HiringVelocityComponents {
  /** 0-1, computeAcceleration(n14, n56) aggregated across all roles -- same formula/version as signal-score.ts's per-role acceleration. */
  acceleration: number;
  /** 0-1, computeBreadth(distinctLocationCount) aggregated across all roles. */
  breadth: number;
  /** 0-1, computeVolumeNorm(totalActiveJobs). */
  volumeNorm: number;
  /** 0-1, computePersistence(daysSinceFirstSignal). */
  persistence: number;
}

export interface HiringVelocityResult {
  score: number;
  components: HiringVelocityComponents;
  formulaVersion: string;
}

/**
 * Company-wide activity stats this function consumes -- aggregated
 * across *all* role categories for one company, unlike
 * packages/db's getCompanyRoleActivityStats (H.2), which is scoped to
 * one (company, role) pair. Q.2's getCompanyActivityStats (new repo
 * function) is the D1-backed source of these fields; this interface is
 * the pure-function boundary between that query and this computation,
 * same split signal-score.ts's ComputeNewJobScoreInput establishes for
 * getCompanyRoleActivityStats.
 */
export interface CompanyActivityStats {
  /** Count of status IN ('active', 'possibly_closed') jobs across every role for this company -- feeds volume_norm. */
  totalActiveJobs: number;
  /** Count of jobs (any role) first_seen in the most-recent-14-day window -- feeds acceleration's n14. */
  newInLast14Days: number;
  /** Count of jobs (any role) first_seen in the 56-day window immediately preceding the 14-day window -- feeds acceleration's n56. */
  newInPrior56Days: number;
  /** Count of distinct (country, region, city, location_mode) tuples among currently-active matching jobs, any role -- feeds breadth. */
  distinctLocationCount: number;
  /** Days (can be fractional) since this company's earliest first_detected_at across all its signals. Null if the company has no signals at all yet -- persistence is then 0 (a company with zero signal history has established nothing yet). */
  daysSinceFirstSignal: number | null;
}

/**
 * Computes a company's hiring velocity score (0-100) from company-wide
 * activity stats. `acceleration`/`breadth` reuse the exact
 * computeAcceleration/computeBreadth formulas from signal-score.ts --
 * same functions, same version, just fed company-wide (all-role)
 * counts instead of per-role ones, per ROADMAP.md Q.1's own wording
 * ("acceleration/breadth reuse computeAcceleration and computeBreadth
 * from signal-score.ts").
 */
export function computeHiringVelocity(stats: CompanyActivityStats): HiringVelocityResult {
  const components: HiringVelocityComponents = {
    acceleration: computeAcceleration(stats.newInLast14Days, stats.newInPrior56Days),
    breadth: computeBreadth(stats.distinctLocationCount),
    volumeNorm: computeVolumeNorm(stats.totalActiveJobs),
    persistence: computePersistence(stats.daysSinceFirstSignal ?? 0),
  };

  const raw =
    WEIGHT_ACCELERATION * components.acceleration +
    WEIGHT_BREADTH * components.breadth +
    WEIGHT_VOLUME * components.volumeNorm +
    WEIGHT_PERSISTENCE * components.persistence;

  return {
    score: Math.round(clamp(raw, 0, 1) * SCORE_MAX),
    components,
    formulaVersion: VELOCITY_FORMULA_VERSION,
  };
}
