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
// the title signal alone; department/description only get inspected (and
// contribute nonzero weight) when title confidence is low (step 5).
const TITLE_MATCH_CONFIDENCE = 1.0;
const NO_TITLE_MATCH_CONFIDENCE = 0.0;
// Threshold below which department/description inspection is triggered.
const LOW_TITLE_CONFIDENCE_THRESHOLD = 0.8;

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
 *   5. department/description inspection only when title confidence is low
 *   6. classificationVersion + confidence always returned (caller persists both)
 *   7. below-threshold results still return rolePrimary if any match was
 *      found (caller decides whether that's "review queue" material) --
 *      this function never silently drops a candidate match.
 */
export function classifyJob(input: ClassificationInput): ClassificationResult {
  const normalizedTitle = normalizeTitle(input.title);
  const titleMatch = matchTextAgainstRules(normalizedTitle);
  const titleConfidence = titleMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;

  // Title confidence high enough: department/description are not
  // inspected at all (spec step 5, "only when title confidence is low").
  if (titleConfidence >= LOW_TITLE_CONFIDENCE_THRESHOLD && titleMatch) {
    const confidence = WEIGHT_TITLE * titleConfidence;
    return {
      rolePrimary: titleMatch.category,
      confidence,
      autoClassified: confidence >= AUTO_CLASSIFY_THRESHOLD,
      classificationVersion: CLASSIFICATION_VERSION,
    };
  }

  // Low (zero) title confidence: inspect department and description,
  // scored against the *same* category candidate pool -- if department
  // or description independently match a rule, that becomes the
  // candidate category.
  const departmentMatch = input.department ? matchTextAgainstRules(normalizeTitle(input.department)) : undefined;
  const descriptionMatch = input.descriptionText
    ? matchTextAgainstRules(normalizeTitle(input.descriptionText))
    : undefined;

  const departmentConfidence = departmentMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;
  const descriptionConfidence = descriptionMatch ? TITLE_MATCH_CONFIDENCE : NO_TITLE_MATCH_CONFIDENCE;

  const candidateCategory = departmentMatch?.category ?? descriptionMatch?.category ?? titleMatch?.category;

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
