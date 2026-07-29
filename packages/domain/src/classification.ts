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
// Each channel that matches contributes its full weight to whichever
// category it matched (see classifyJob's per-category scoring, L1 fix)
// -- there's no separate "match confidence" scalar since a match is
// binary (a channel either hits a category at full weight, or doesn't
// contribute to it at all).
const WEIGHT_TITLE = 0.7;
const WEIGHT_DEPARTMENT = 0.2;
const WEIGHT_DESCRIPTION = 0.1;

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
 *   5b. per-category scoring + disagreement penalty (bug fix, logic
 *      review L1): title/department/description can each match a
 *      *different* category (e.g. title says "Data Engineer" but
 *      department is "Security"). The previous implementation picked
 *      whichever channel's category happened to be first in
 *      `titleMatch ?? departmentMatch ?? descriptionMatch` and then
 *      summed *all three* channels' weight into that one category's
 *      confidence -- so a mislabeled job could reach 0.90+ confidence
 *      in the *wrong* category, which is worse than no signal at all
 *      (spec's own framing: a wrong-category signal erodes trust more
 *      than an absent one). Fixed by scoring each category
 *      independently from whichever channels actually matched it, then
 *      picking the top-scoring category and applying a discount when
 *      more than one distinct category was hit (channels disagreed).
 *   5c. description-channel noise guard (bug fix, logic review H.1,
 *      2026-07-29): title/department are structured, curated fields
 *      describing the role's own identity; description is unstructured
 *      prose that routinely mentions *other* roles the person will work
 *      alongside ("you'll collaborate with our Security team"). Feeding
 *      description into the same disagreement-penalty math as
 *      title/department let one incidental phrase knock a correctly
 *      classified job below AUTO_CLASSIFY_THRESHOLD -- e.g.
 *      title="Software Engineer" + department="Software Engineer"
 *      (0.7+0.2=0.9) with a description mentioning "our Security team"
 *      discounted to 0.9*0.85=0.765, below 0.80, even though both
 *      structured fields agreed. Fixed: description only contributes to
 *      categoryScores when it either (a) confirms a category a
 *      structured channel (title or department) already matched -- pure
 *      confirmation, never a competing vote -- or (b) is the only
 *      evidence available at all (title and department both matched
 *      nothing, the pre-existing "last resort" path). A description
 *      match that disagrees with an existing structured match is
 *      dropped before scoring, not counted as a third vote. See
 *      applyDescriptionGuard below.
 *   6. classificationVersion + confidence always returned (caller persists both)
 *   7. below-threshold results still return rolePrimary if any match was
 *      found (caller decides whether that's "review queue" material) --
 *      this function never silently drops a candidate match.
 */
export function classifyJob(input: ClassificationInput): ClassificationResult {
  const normalizedTitle = normalizeTitle(input.title);
  const titleMatch = matchTextAgainstRules(normalizedTitle);

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
  const rawDescriptionMatch = input.descriptionText
    ? matchTextAgainstRules(normalizeTitle(input.descriptionText))
    : undefined;

  // H.1 guard: description only counts as a scoring channel when it
  // confirms a structured (title/department) match, or when title and
  // department both matched nothing at all (last-resort path, spec 6.2
  // step 5's "inspect ... when title confidence is low"). A description
  // match that disagrees with an existing structured match is noise
  // (see this function's header comment, step 5c) -- dropped here,
  // before it ever reaches categoryScores, rather than counted as a
  // competing vote and then discounted.
  const structuredCategories = new Set<RoleCategory>();
  if (titleMatch) structuredCategories.add(titleMatch.category);
  if (departmentMatch) structuredCategories.add(departmentMatch.category);
  const descriptionMatch =
    rawDescriptionMatch === undefined
      ? undefined
      : structuredCategories.size === 0 || structuredCategories.has(rawDescriptionMatch.category)
        ? rawDescriptionMatch
        : undefined;

  // Score each *category* independently -- a channel only contributes
  // its weight to the category it actually matched, never to whichever
  // category another channel happened to match.
  const categoryScores = new Map<RoleCategory, number>();
  const addChannel = (match: { category: RoleCategory } | undefined, weight: number) => {
    if (!match) return;
    categoryScores.set(match.category, (categoryScores.get(match.category) ?? 0) + weight);
  };
  addChannel(titleMatch, WEIGHT_TITLE);
  addChannel(departmentMatch, WEIGHT_DEPARTMENT);
  addChannel(descriptionMatch, WEIGHT_DESCRIPTION);

  // Pick the highest-scoring category. Ties broken by channel priority
  // (title > department > description), matching this function's
  // existing precedence for "which category wins" when scores are
  // otherwise equal (including the common single-channel-match case,
  // where there's only one candidate and this loop is a no-op).
  let candidateCategory: RoleCategory | undefined;
  let bestScore = 0;
  for (const match of [titleMatch, departmentMatch, descriptionMatch]) {
    if (!match) continue;
    const score = categoryScores.get(match.category) ?? 0;
    if (candidateCategory === undefined || score > bestScore) {
      candidateCategory = match.category;
      bestScore = score;
    }
  }

  // Disagreement penalty: when title/department/description didn't all
  // point at the same category, the winning category's raw score
  // overstates how sure we actually are -- the channels are telling us
  // *different* things about this job, not reinforcing each other. A
  // 2-way split (e.g. title says A, department says B) discounts by
  // 15%; a full 3-way split discounts by 30%.
  //
  // Under the H.1 guard above, description can never be the *source* of
  // a third distinct category -- it only ever scores into a category
  // title or department already matched, or stands alone when neither
  // matched anything (a single-channel case, no disagreement possible
  // either way). So distinctCategoriesMatched maxes out at 2
  // (title-vs-department) in practice today. The `>= 3` branch below
  // stays in the code for defensiveness -- e.g. if a future change adds
  // another structured channel -- but is dead code under the current
  // two-structured-channel design. Noted explicitly so a future reader
  // doesn't mistake it for untested/forgotten rather than deliberately
  // unreachable.
  const distinctCategoriesMatched = categoryScores.size;
  const disagreementMultiplier = distinctCategoriesMatched <= 1 ? 1.0 : distinctCategoriesMatched === 2 ? 0.85 : 0.7;

  const confidence = bestScore * disagreementMultiplier;

  return {
    rolePrimary: candidateCategory,
    confidence,
    autoClassified: confidence >= AUTO_CLASSIFY_THRESHOLD,
    classificationVersion: CLASSIFICATION_VERSION,
  };
}
