import { AUTO_CLASSIFY_THRESHOLD } from "./classification";
import type { RoleCategory } from "./role-taxonomy";

/**
 * Centroid-similarity classification nudge (spec §9.4 capability 2,
 * ROADMAP.md I.5b). Deliberately its OWN file, not added to
 * classification.ts -- that file's header comment states its no-LLM/
 * no-embedding-dependency design explicitly ("No LLM dependency by
 * design"), and this module's whole existence is an embedding-consuming
 * function. Keeping them separate means classification.ts stays
 * importable and unit-testable in a context with no Vectorize/AI
 * available at all (exactly as it is today), and this file's own
 * dependency on a centroid similarity score is visible at the import
 * boundary rather than buried inside classifyJob's internals.
 *
 * Binding queries, retries, circuit-breaking, and the "only call this
 * when confidence is low" gating all live in the ingest consumer
 * (I.5c) -- this file is pure score-in, nudge-out arithmetic, unit
 * testable with plain numbers as fixtures, no Cloudflare bindings
 * imported here at all.
 */

/** Version string for the nudge formula itself, mirrors
 * CLASSIFICATION_VERSION/SCORE_FORMULA_VERSION's own "bump when the
 * formula changes" convention (classification.ts, signal-score.ts) --
 * not currently persisted anywhere (I.5c doesn't add a new column),
 * kept here so a future persistence decision has a version string
 * ready rather than needing one invented after the fact. */
export const CLASSIFICATION_ASSIST_VERSION = "v1";

/**
 * A confidence value only qualifies for a nudge if it's below this
 * ceiling -- there is no numeric "low confidence" threshold defined
 * anywhere upstream (spec §6.2 step 5's "only when title confidence is
 * low" governs an inspection-order optimization inside classifyJob, not
 * a literal gate -- see classification.ts's own 2026-07-28 bug-fix
 * comment for why department/description are always inspected
 * regardless). AUTO_CLASSIFY_THRESHOLD is the one number that actually
 * exists and is meaningful here: a job already at or above it needs no
 * disambiguation help, and spec §9.4 forbids the nudge from being a
 * precondition for classification running at all -- so gating on "below
 * the auto-classify line" is the natural, spec-consistent reading, not
 * an invented one.
 */
export const NUDGE_ELIGIBLE_BELOW_CONFIDENCE = AUTO_CLASSIFY_THRESHOLD;

/**
 * Ceiling on how much the nudge can move confidence, in either
 * direction. Deliberately small relative to AUTO_CLASSIFY_THRESHOLD's
 * gap from a typical single-channel score (WEIGHT_TITLE alone = 0.70,
 * see classification.ts) -- spec §9.4's guardrail is that semantic
 * similarity may only ever *nudge* an already-computed score, never
 * substitute for deterministic evidence. A cap well under the
 * 0.70-to-0.80 gap keeps this function structurally incapable of being
 * the dominant factor in an autoClassified flip, even at maximum
 * cosine similarity -- the deterministic channels still have to have
 * done most of the work.
 */
export const MAX_NUDGE_MAGNITUDE = 0.05;

export interface CentroidSimilarityInput {
  /** classifyJob's own result for this job -- the nudge only ever agrees or disagrees with rolePrimary, never proposes its own category. */
  rolePrimary: RoleCategory | undefined;
  /** classifyJob's own confidence, 0-1. */
  confidence: number;
  /** Cosine similarity (Vectorize's own `score`, already cosine per this index's metric config -- see I.1) between the job's embedding and rolePrimary's centroid vector ONLY. Caller queries exactly one centroid (filter: { kind: "category_centroid", roleCategory: rolePrimary }), never all 10 -- this function has no way to pick a different category even if it wanted to. */
  centroidSimilarity: number;
}

export interface CentroidSimilarityResult {
  /** confidence + nudge, clamped to [0, 1] -- never below the input confidence's floor of 0 or above 1, regardless of nudge sign/magnitude. */
  nudgedConfidence: number;
  /** The raw, unclamped adjustment applied -- kept in the result for observability/logging even though callers generally only need nudgedConfidence. */
  nudge: number;
  classificationAssistVersion: string;
}

/**
 * Applies a small, bounded confidence adjustment based on how well a
 * job's embedding agrees with its already-chosen category's centroid.
 * Pure function -- no Vectorize/AI call happens here, the caller (I.5c,
 * ingest-consumer.ts) already resolved centroidSimilarity before calling
 * this.
 *
 * NEVER picks or changes rolePrimary -- returns only a numeric
 * adjustment to confidence. NEVER called (by contract, enforced by the
 * caller per I.5c, not here) when rolePrimary is undefined -- a
 * similarity score has no category to agree or disagree WITH if
 * classifyJob found no deterministic match at all, so there is nothing
 * for this function to meaningfully nudge; the caller must not invoke
 * it in that case rather than this function silently no-op'ing on it.
 *
 * Linear mapping, not a lookup table or step function: similarity is
 * already a bounded, continuous cosine score in [-1, 1] in principle
 * (in practice bge-base-en-v1.5 + real job/centroid text pairs land
 * solidly in [0, 1] for on-topic comparisons, per this repo's own
 * MIN_RELATIVE_SCORE-style empirical precedent in semantic-search.ts's
 * VECTORIZE_TOP_K sibling constant) -- centered at 0.5 similarity as
 * "neutral, no adjustment" rather than at 0, since two unrelated
 * job-title embeddings under this model rarely score anywhere near 0
 * cosine similarity in practice (short, topically-narrow text, not
 * long documents) -- 0 would make the "no adjustment" point unreachable
 * for realistic inputs and the function would always nudge one
 * direction or the other, never neutral.
 */
export function applyClassificationAssist(
  input: CentroidSimilarityInput,
): CentroidSimilarityResult {
  const raw = (input.centroidSimilarity - 0.5) * 2 * MAX_NUDGE_MAGNITUDE;
  const nudge = Math.max(-MAX_NUDGE_MAGNITUDE, Math.min(MAX_NUDGE_MAGNITUDE, raw));
  const nudgedConfidence = Math.max(0, Math.min(1, input.confidence + nudge));

  return {
    nudgedConfidence,
    nudge,
    classificationAssistVersion: CLASSIFICATION_ASSIST_VERSION,
  };
}
