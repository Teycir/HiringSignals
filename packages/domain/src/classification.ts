import { normalizeTitle } from "./title-normalize";
import {
  ABBREVIATION_RULES,
  NEGATIVE_TERM_RULES,
  PHRASE_RULES,
  type AbbreviationRule,
  type PhraseRule,
} from "./role-rules";
import type { RoleCategory } from "./role-taxonomy";

/**
 * Deterministic job classification (spec 6.2). No LLM dependency by
 * design -- spec 6.2 opener: "Use deterministic rules first. Do not make
 * an LLM dependency necessary for the ingestion pipeline."
 */

/** Bump when PHRASE_RULES/ABBREVIATION_RULES/NEGATIVE_TERM_RULES or the
 * scoring weights change, so `classification_version` on stored job rows
 * stays a meaningful audit trail (spec 6.2 step 6). */
export const CLASSIFICATION_VERSION = "v1";

/** Auto-classify only at or above this confidence (spec 6.2, "Only
 * classify automatically when C_role >= 0.80"). Named constant, not
 * inlined, per the same "configurable" requirement lifecycle thresholds
 * get in spec 5.4. */
export const AUTO_CLASSIFY_THRESHOLD = 0.8;

// Confidence weights for C_role = 0.70*C_title + 0.20*C_department + 0.10*C_description (spec 6.2 formula).
const WEIGHT_TITLE = 0.7;
const WEIGHT_DEPARTMENT = 0.2;
const WEIGHT_DESCRIPTION = 0.1;

// A title-only phrase/abbreviation hit is treated as fully confident from
// the title signal alone. Department/description are always inspected
// when provided and their scores always contribute (bug fix 2026-07-28,
// see classifyJob's comment) -- title confidence being high does not
// exclude their weight from the sum.
const TITLE_MATCH_CONFIDENCE = 1.0;
const NO_TITLE_MATCH_CONFIDENCE = 0.0;

export interface ClassificationInput {
  title: string;
  department?: string;
  descriptionText?: string;
}

export interface ClassificationResult {
  /** Highest-confidence category, or undefined if nothing matched at all. */
  rolePrimary: RoleCategory | undefined;
  /** C_role, 0 to 1. */
  confidence: number;
  /** True only when confidence >= AUTO_CLASSIFY_THRESHOLD. */
  autoClassified: boolean;
  classificationVersion: string;
}

function wordBoundaryIncludes(normalizedText: string, phrase: string): boolean {
  // normalizedText and phrase are both already normalized (lowercase,
  // punctuation stripped, whitespace collapsed to single spaces), so a
  // padded-space substring check is a safe, cheap word-boundary test.
  return ` ${normalizedText} `.includes(` ${phrase} `);
}

function isNegated(normalizedText: string, category: RoleCategory): boolean {
  return NEGATIVE_TERM_RULES.some(
    (rule) => rule.category === category && wordBoundaryIncludes(normalizedText, rule.term),
  );
}

/** Find the first rule (phrase, then abbreviation) that matches, honoring
 * the negative-term guard (spec 6.2 step 4: applied before a match is
 * accepted, not as a post-hoc filter). PHRASE_RULES is checked first
 * since it's the higher-precision signal (step 2 before step 3). */
function matchTextAgainstRules(
  normalizedText: string,
): { category: RoleCategory; source: "phrase" | "abbreviation" } | undefined {
  const phraseHit = PHRASE_RULES.find(
    (rule: PhraseRule) =>
      wordBoundaryIncludes(normalizedText, rule.phrase) && !isNegated(normalizedText, rule.category),
  );
  if (phraseHit) return { category: phraseHit.category, source: "phrase" };

  const abbreviationHit = ABBREVIATION_RULES.find(
    (rule: AbbreviationRule) =>
      wordBoundaryIncludes(normalizedText, rule.abbreviation) &&
      !isNegated(normalizedText, rule.category),
  );
  if (abbreviationHit) return { category: abbreviationHit.category, source: "abbreviation" };

  return undefined;
}

/**
 * Classify a job into a role category using deterministic rules only.
 * Steps map 1:1 to spec 6.2:
 *   1. normalizeTitle (title-normalize.ts)
 *   2-3. phrase/abbreviation matching (matchTextAgainstRules)
 *   4. negative-term guard (isNegated, applied inside matchTextAgainstRules)
 *   5. department/description inspection, always combined with title
 *      score in the weighted sum (bug fix 2026-07-28: previously
 *      short-circuited on title match alone, capping confidence at 0.70
 *      and making the >= 0.80 auto-classify threshold unreachable)
 *   6. classificationVersion + confidence always returned (caller persists both)
 *   7. below-threshold results still return rolePrimary if any match was
 *      found (caller decides whether that's "review queue" material) --
 *      this function never silently drops a candidate match.
 */
export function classifyJob(input: ClassificationInput): ClassificationResult {
  const normalizedTitle = normalizeTitle(input.title);
  const titleMatch = matchTextAgainstRules(normalizedTitle);
  const titleConfidence = titleMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;

  // Bug fix (2026-07-28): the previous implementation early-returned
  // WEIGHT_TITLE * titleConfidence (capped at 0.70) whenever the title
  // matched, skipping department/description entirely per a literal
  // reading of step 5 ("inspect ... only when title confidence is low").
  // That made C_role >= 0.80 mathematically unreachable for every input
  // -- the title-match branch topped out at 0.70 and the no-title-match
  // branch topped out at 0.20 + 0.10 = 0.30 -- so classifyJob could
  // never return autoClassified: true, silently making the ingest
  // consumer's signal-generation branch (gated on that flag) dead code.
  // Step 5's "only when title confidence is low" governs whether
  // department/description inspection can be *skipped* as an
  // optimization when title certainty alone already resolves the
  // category, not whether their scores are excluded once inspected --
  // the formula itself has no such exclusion. Fix: always inspect
  // department/description when provided, always sum all three weighted
  // terms.
  const departmentMatch = input.department ? matchTextAgainstRules(normalizeTitle(input.department)) : undefined;
  const descriptionMatch = input.descriptionText
    ? matchTextAgainstRules(normalizeTitle(input.descriptionText))
    : undefined;

  const departmentConfidence = departmentMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;
  const descriptionConfidence = descriptionMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;

  const candidateCategory = titleMatch?.category ?? departmentMatch?.category ?? descriptionMatch?.category;

  const confidence =
    WEIGHT_TITLE * titleConfidence +
    WEIGHT_DEPARTMENT * departmentConfidence +
    WEIGHT_DESCRIPTION * descriptionConfidence;

  return {
    rolePrimary: candidateCategory,
    confidence,
    autoClassified: confidence >= AUTO_CLASSIFY_THRESHOLD,
    classificationVersion: CLASSIFICATION_VERSION,
  };
}
