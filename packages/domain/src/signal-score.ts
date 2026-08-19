/**
 * Signal score computation (spec 7.2). Pure function, no D1 -- same
 * reasoning as classification.ts/lifecycle.ts: recomputability from
 * persisted observations is a spec requirement ("Scores must be
 * recomputable from persisted observations"), which is only checkable if
 * the formula lives somewhere unit-testable without a database.
 *
 * v2 (ROADMAP.md Milestone H.3): V/A/B are now computed from real
 * company+role activity stats (packages/db's
 * getCompanyRoleActivityStats, Milestone H.2) instead of the v1 fixed
 * 0.5 neutral constant. This module documents, per-field, what v2
 * actually computes -- spec 7.2 requires "every component score, formula
 * version, and inputs" to be recoverable from signal_evidence, so a
 * later milestone reading v2-computed evidence can rely on this
 * SCORE_FORMULA_VERSION bump to tell it apart from v1 rows (fixed 0.5
 * V/A/B) already persisted before this change.
 *
 * v3 (2026-08-19): computeAcceleration gained a cold-start branch. On a
 * young dataset, most company+role pairs have newInPrior56Days=0 (no
 * prior-window history yet, not "zero growth") -- feeding that through
 * spec 7.2's relative-rate formula collapses the denominator to its
 * max(2, ...) floor, so ANY newInLast14Days>=2 saturates acceleration
 * to 1.0 regardless of whether it's 2 or 200 (confirmed live: 11/14
 * companies with jobs were already pinned at 1.0). v3 special-cases
 * newInPrior56Days=0 to an absolute scale on newInLast14Days instead of
 * the relative-rate comparison -- see computeAcceleration's own comment
 * for the exact formula. Every other input (newInPrior56Days>0) is
 * byte-identical to v2; this bump exists only so signal_evidence rows
 * scored before/after this change are distinguishable, per spec 7.2's
 * "formula version" recomputability requirement.
 */

export const SCORE_FORMULA_VERSION = "v3";

// Weights from spec 7.2: S = min(100, 35R + 25V + 20A + 10B + 10Q - P).
const WEIGHT_FRESHNESS = 35;
const WEIGHT_VOLUME = 25;
const WEIGHT_ACCELERATION = 20;
const WEIGHT_BREADTH = 10;
const WEIGHT_QUALITY = 10;
const SCORE_MAX = 100;

// Freshness decay half-life-ish constant: R = e^(-d/14), d = days since
// the signal's most recent evidence observation (spec 7.2).
const FRESHNESS_DECAY_DAYS = 14;

export interface ScoreComponents {
  /** R: freshness, 0-1, from days since most recent evidence observation. */
  freshness: number;
  /** V: matching active-role volume, 0-1. computeVolume(activeMatchingCount). */
  volume: number;
  /** A: acceleration, 0-1. computeAcceleration(newInLast14Days, newInPrior56Days), spec §7.2's exact formula. */
  acceleration: number;
  /** B: breadth (location diversity), 0-1. computeBreadth(distinctLocationCount). */
  breadth: number;
  /** Q: data-quality / role-classification confidence, 0-1. Real input: classification_confidence. */
  quality: number;
  /** P: penalties (stale listings, duplicate patterns, low source reliability), >= 0, subtracted. v1/v2: always 0 (no penalty inputs implemented yet). */
  penalty: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponents;
  formulaVersion: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes R = e^(-d/14) where d is days (can be fractional) since the
 * most recent evidence observation. Clamped to [0,1] like every other
 * component (computeVolume/computeAcceleration/computeBreadth) --
 * without this, clock skew producing a negative d makes e^(-d/14)
 * exceed 1.0, which would violate ScoreComponents' documented [0,1]
 * range and get persisted verbatim to signal_evidence.payload_json,
 * breaking spec §7.2 recomputability.
 */
export function computeFreshness(daysSinceObservation: number): number {
  return clamp(Math.exp(-daysSinceObservation / FRESHNESS_DECAY_DAYS), 0, 1);
}

/**
 * V: matching active-role volume, 0-1 (Milestone H.3). No spec formula
 * given for V -- 5 is a documented v2 choice (unlike B's 3, which is
 * spec-derived from the multi_location threshold), not derived from a
 * spec threshold. Revisit once real ingestion volume shows what a "high"
 * active count actually looks like in practice.
 */
const VOLUME_SCALE = 5;
export function computeVolume(activeMatchingCount: number): number {
  return clamp(activeMatchingCount / VOLUME_SCALE, 0, 1);
}

/**
 * A: acceleration, 0-1 (Milestone H.3, spec §7.2's exact formula):
 * clamp((n14 - n56/4) / max(2, n56/4), 0, 1). n14/n56 are counts of jobs
 * first_seen in the most-recent-14-day window and the 56-day window
 * immediately preceding it (H.2's newInLast14Days/newInPrior56Days).
 * Dividing n56 by 4 normalizes the 56-day count to a comparable 14-day
 * rate before comparing against the actual 14-day count -- the max(2, ...)
 * floor prevents a near-zero denominator from producing an extreme ratio
 * when a company+role has little to no prior history.
 *
 * v3 cold-start branch: when n56=0, there is no prior-window history at
 * all -- not "zero growth," just no baseline to be relative to. Feeding
 * that through the ratio above collapses priorRate to 0 and the
 * denominator to its floor of 2, so ANY n14>=2 clamps straight to 1.0
 * regardless of whether n14 is 2 or 200 -- confirmed live on this
 * dataset, where 11 of 14 companies with any jobs were already pinned
 * at exactly 1.0 for this reason, making the trends chart's top-N
 * ranking arbitrary among ties. Acceleration (rate of change vs. a
 * baseline) isn't a meaningful question when the baseline is undefined,
 * so n56=0 is scored on an absolute scale instead:
 * clamp(n14 / COLD_START_SCALE, 0, 1). COLD_START_SCALE=10 is a
 * documented v3 guess (same spirit as VOLUME_SCALE/BREADTH_SCALE below,
 * not spec-derived) -- revisit once enough companies accumulate real
 * 56-day history that n56=0 stops being the dominant case.
 */
const COLD_START_SCALE = 10;
export function computeAcceleration(newInLast14Days: number, newInPrior56Days: number): number {
  if (newInPrior56Days === 0) {
    return clamp(newInLast14Days / COLD_START_SCALE, 0, 1);
  }
  const priorRate = newInPrior56Days / 4;
  return clamp((newInLast14Days - priorRate) / Math.max(2, priorRate), 0, 1);
}

/**
 * B: breadth (location diversity), 0-1 (Milestone H.3):
 * clamp(distinctLocationCount / 3, 0, 1). 3 is not arbitrary -- it's the
 * same threshold spec §7.1 uses to define the multi_location signal type
 * itself (Milestone H.4), so the score's B component and the
 * multi_location trigger stay conceptually aligned instead of using two
 * unrelated numbers for "notable location breadth."
 */
const BREADTH_SCALE = 3;
export function computeBreadth(distinctLocationCount: number): number {
  return clamp(distinctLocationCount / BREADTH_SCALE, 0, 1);
}

export interface ComputeNewJobScoreInput {
  /** Days (can be fractional) since the job's posting/observation that this signal is anchored to. */
  daysSinceObservation: number;
  /** classification_confidence for the anchoring job, 0-1. Feeds Q directly -- an unclassified/low-confidence job should rank lower. */
  classificationConfidence: number;
  /** Count of status IN ('active', 'possibly_closed') jobs for this (company, role) -- feeds V. From H.2's getCompanyRoleActivityStats. */
  activeMatchingCount: number;
  /** Count of jobs first_seen in the most-recent-14-day window for this (company, role) -- feeds A. */
  newInLast14Days: number;
  /** Count of jobs first_seen in the 56-day window immediately preceding the 14-day window -- feeds A. */
  newInPrior56Days: number;
  /** Count of distinct (country, region, city, location_mode) tuples among currently-active matching jobs -- feeds B. */
  distinctLocationCount: number;
}

/**
 * Score a `new_job`/`reopened_job` signal per spec §7.2's formula, with
 * V/A/B computed for real from company+role activity stats (Milestone
 * H.3, H.2's getCompanyRoleActivityStats) and Q taken directly from the
 * job's classification confidence. P is always 0 (no penalty inputs
 * implemented yet -- a real P requires source-reliability history this
 * milestone doesn't have either).
 */
export function computeNewJobScore(input: ComputeNewJobScoreInput): ScoreResult {
  const components: ScoreComponents = {
    freshness: computeFreshness(input.daysSinceObservation),
    volume: computeVolume(input.activeMatchingCount),
    acceleration: computeAcceleration(input.newInLast14Days, input.newInPrior56Days),
    breadth: computeBreadth(input.distinctLocationCount),
    quality: clamp(input.classificationConfidence, 0, 1),
    penalty: 0,
  };

  return combineComponents(components);
}

/**
 * Combines already-computed R/V/A/B/Q/P components into the final
 * bounded score per spec §7.2's formula. Shared by computeNewJobScore
 * and computeReconciliationScore (Milestone H.5) so the weighted-sum/
 * clamp/round logic lives in exactly one place -- the two functions
 * differ only in how `freshness` gets anchored, not in how the five
 * components combine into a score.
 */
function combineComponents(components: ScoreComponents): ScoreResult {
  const raw =
    WEIGHT_FRESHNESS * components.freshness +
    WEIGHT_VOLUME * components.volume +
    WEIGHT_ACCELERATION * components.acceleration +
    WEIGHT_BREADTH * components.breadth +
    WEIGHT_QUALITY * components.quality -
    components.penalty;

  return {
    score: Math.round(Math.min(SCORE_MAX, Math.max(0, raw))),
    components,
    formulaVersion: SCORE_FORMULA_VERSION,
  };
}

export interface ComputeReconciliationScoreInput {
  /** Days (can be fractional) since the signal's last_detected_at -- the reconciliation-specific freshness anchor (Milestone H.5), distinct from computeNewJobScore's postedAt/first_seen_at anchor. See this module's header + ROADMAP.md H.5 for why these are two different, both-correct anchors rather than one superseding the other. */
  daysSinceLastDetected: number;
  /** classification_confidence for the anchoring job, 0-1. Same Q semantics as computeNewJobScore. */
  classificationConfidence: number;
  /** Count of status IN ('active', 'possibly_closed') jobs for this (company, role), refetched fresh at reconciliation time -- feeds V. */
  activeMatchingCount: number;
  /** Count of jobs first_seen in the most-recent-14-day window, refetched fresh -- feeds A. */
  newInLast14Days: number;
  /** Count of jobs first_seen in the 56-day window immediately preceding the 14-day window, refetched fresh -- feeds A. */
  newInPrior56Days: number;
  /** Count of distinct locations among currently-active matching jobs, refetched fresh -- feeds B. */
  distinctLocationCount: number;
}

/**
 * Recomputes a signal's score at reconciliation time (Milestone H.5,
 * spec §5.2/§7.2), for signals that have gone quiet (no new evidence
 * since last_detected_at) and so never get a natural score refresh from
 * the ingest-consumer's new-evidence path. Reuses the exact same
 * computeVolume/computeAcceleration/computeBreadth/combineComponents as
 * computeNewJobScore -- the only difference is the freshness anchor:
 * here it's days-since-last_detected_at (this signal's own most recent
 * evidence observation, spec §7.2's literal wording), not
 * days-since-postedAt/first_seen_at (computeNewJobScore's anchor, which
 * exists to optimize *detection latency*, spec §1.1 -- see this module's
 * header comment and ROADMAP.md H.5 for the full reasoning on why both
 * anchors are correct for their respective purposes, not one superseding
 * the other). V/A/B inputs should be refetched fresh from H.2's
 * getCompanyRoleActivityStats at call time, not reused from the
 * signal's original creation-time evidence -- that's what makes
 * reconciliation a real improvement (current activity picture) and not
 * just a freshness-decay recompute.
 */
export function computeReconciliationScore(input: ComputeReconciliationScoreInput): ScoreResult {
  const components: ScoreComponents = {
    freshness: computeFreshness(input.daysSinceLastDetected),
    volume: computeVolume(input.activeMatchingCount),
    acceleration: computeAcceleration(input.newInLast14Days, input.newInPrior56Days),
    breadth: computeBreadth(input.distinctLocationCount),
    quality: clamp(input.classificationConfidence, 0, 1),
    penalty: 0,
  };

  return combineComponents(components);
}
