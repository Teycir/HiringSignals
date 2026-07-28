/**
 * Signal score computation (spec 7.2). Pure function, no D1 -- same
 * reasoning as classification.ts/lifecycle.ts: recomputability from
 * persisted observations is a spec requirement ("Scores must be
 * recomputable from persisted observations"), which is only checkable if
 * the formula lives somewhere unit-testable without a database.
 *
 * v1 scope (ROADMAP.md Milestone C): `new_job` signals only. The full
 * formula has five positive components (R/V/A/B/Q) and a penalty term
 * (P); a freshly-created new_job signal has exactly one piece of
 * evidence, so several components don't have real history to compute
 * from yet. This module documents, per-field, what v1 actually computes
 * vs. what the full formula eventually will -- spec 7.2 requires "every
 * component score, formula version, and inputs" to be recoverable from
 * signal_evidence, so a later milestone reading v1-computed evidence
 * must be able to tell the difference from a later formula version.
 */

export const SCORE_FORMULA_VERSION = "v1";

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
  /** V: matching active-role volume, 0-1. v1 new_job: fixed neutral value (see header comment). */
  volume: number;
  /** A: acceleration, 0-1. v1 new_job: fixed neutral value (no baseline yet). */
  acceleration: number;
  /** B: breadth (location/team diversity), 0-1. v1 new_job: fixed neutral value (single job = no diversity to measure). */
  breadth: number;
  /** Q: data-quality / role-classification confidence, 0-1. Real input: classification_confidence. */
  quality: number;
  /** P: penalties (stale listings, duplicate patterns, low source reliability), >= 0, subtracted. v1: always 0 (no penalty inputs implemented yet). */
  penalty: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponents;
  formulaVersion: string;
}

/**
 * v1 simplification for a freshly-created/refreshed `new_job` signal
 * (ROADMAP.md Milestone C, spec §20 Phase 1 step 5's build-order note):
 * volume/acceleration/breadth need historical baselines (14-day vs.
 * 56-day windows per spec's A formula, multi-location counts, etc.) that
 * don't exist meaningfully for a single just-observed job. Rather than
 * inventing a number, v1 fixes these three at a documented neutral
 * midpoint (0.5) so they contribute a stable, explainable baseline
 * rather than silently zeroing out 55% of the formula's weight (25+20+10)
 * -- zeroing would make freshness alone determine nearly the whole score
 * for every new_job signal, which understates the formula's intent even
 * in v1. A future milestone computing real V/A/B replaces this constant
 * with the real spec §7.2 formulas once volume baselines exist.
 */
const V1_NEUTRAL_COMPONENT = 0.5;

/**
 * Computes R = e^(-d/14) where d is days (can be fractional) since the
 * most recent evidence observation.
 */
export function computeFreshness(daysSinceObservation: number): number {
  return Math.exp(-daysSinceObservation / FRESHNESS_DECAY_DAYS);
}

export interface ComputeNewJobScoreInput {
  /** Days (can be fractional) since the job's posting/observation that this signal is anchored to. */
  daysSinceObservation: number;
  /** classification_confidence for the anchoring job, 0-1. Feeds Q directly -- an unclassified/low-confidence job should rank lower. */
  classificationConfidence: number;
}

/**
 * Score a `new_job` signal per spec §7.2's formula, with V/A/B fixed at
 * the v1 neutral constant (see V1_NEUTRAL_COMPONENT doc comment) and Q
 * taken directly from the job's classification confidence. P is always 0
 * in v1 (no penalty inputs implemented yet -- spec doesn't block Milestone
 * C on this, and a real P requires source-reliability history Milestone C
 * doesn't have either).
 */
export function computeNewJobScore(input: ComputeNewJobScoreInput): ScoreResult {
  const components: ScoreComponents = {
    freshness: computeFreshness(input.daysSinceObservation),
    volume: V1_NEUTRAL_COMPONENT,
    acceleration: V1_NEUTRAL_COMPONENT,
    breadth: V1_NEUTRAL_COMPONENT,
    quality: input.classificationConfidence,
    penalty: 0,
  };

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
