/**
 * Title normalization (spec 6.2 step 1): lowercase, Unicode-normalize
 * (NFKC), strip punctuation, collapse whitespace.
 *
 * Deliberately minimal -- this is the first, cheapest step in the
 * classification pipeline and the spec lists exactly these four
 * transforms. Do not add stemming, stopword removal, or synonym
 * expansion here; that belongs (if ever needed) in the phrase-rule
 * matcher, not in normalization.
 *
 * NFKC (compatibility decomposition + canonical composition) is used
 * over NFC so visually-equivalent characters from different Unicode
 * blocks (e.g. fullwidth Latin, ligatures) collapse to the same
 * normalized form before phrase matching -- job titles scraped from
 * varied ATS platforms are not guaranteed consistent Unicode forms.
 */

// Punctuation/symbol stripping: keep letters, numbers, and whitespace only.
// Runs after NFKC so composed punctuation forms are already canonicalized.
const PUNCTUATION_PATTERN = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_PATTERN = /\s+/g;

export function normalizeTitle(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCTUATION_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}
