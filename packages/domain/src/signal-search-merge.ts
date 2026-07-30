/**
 * Pure merge logic for spec §9.4's hybrid search: combines the existing
 * keyword-matched signal rows (company/headline/summary LIKE match, via
 * packages/db's listSignals) with semantically-matched signal rows
 * (resolved from Vectorize job-ID hits via packages/db's
 * findSignalsByJobIds) into one ranked list.
 *
 * D1-free and framework-agnostic on purpose, same reasoning as
 * signal-score.ts/classification.ts -- this is pure ranking math over
 * already-fetched rows, independently unit-testable without a D1 or
 * Vectorize double. Lives in packages/domain (not packages/db) because
 * it doesn't touch SQL at all; packages/db's own "no hono, D1-only"
 * convention doesn't apply here, but "no framework, pure function"
 * still does.
 */

/** Minimal shape this module needs from a signal row -- deliberately not
 * importing packages/db's SignalListItem to avoid a domain -> db
 * dependency (db already depends on domain, not the other way around). */
export interface MergeableSignal {
  id: string;
}

export interface KeywordMatch<T extends MergeableSignal> {
  signal: T;
}

export interface SemanticMatch<T extends MergeableSignal> {
  signal: T;
  /** Vectorize cosine similarity score for this match, already scoped to
   * the query that produced it. Callers pass the *best* (highest) score
   * across any job belonging to this signal if more than one of the
   * signal's evidence jobs matched the same query. */
  similarity: number;
}

export interface MergedSignalMatch<T extends MergeableSignal> {
  signal: T;
  /** Combined ranking score used to sort the merged list -- NOT the
   * signal's own persisted `score` column (spec §7.2's hiring-signal
   * score); this is purely a search-relevance ranking value, scoped to
   * one query, never persisted. */
  matchScore: number;
  matchedVia: "keyword" | "semantic" | "both";
}

const KEYWORD_WEIGHT = 1;
/** Semantic hits are weighted below a keyword hit by default -- an exact
 * substring match on company/headline/summary is stronger evidence of
 * relevance than embedding similarity, mirroring ArxivExplorer's own
 * KEYWORD_WEIGHT < SEMANTIC_WEIGHT... except inverted here on purpose:
 * ArxivExplorer's keyword leg is BM25 over long abstracts (a noisy,
 * partial-credit signal), while this repo's keyword leg is a direct
 * substring match on short, dense fields (headline/summary/company
 * name) -- a much stronger relevance signal than BM25, so it gets the
 * higher weight instead. Semantic gets meaningful weight but doesn't
 * dominate a query that already got a clean literal match. */
const SEMANTIC_WEIGHT = 0.6;

/**
 * Merges keyword and semantic matches, deduplicating by signal.id. A
 * signal present in both legs sums its (weighted) scores and is marked
 * "both" -- reflecting stronger combined evidence of relevance than
 * either leg alone, same principle as ArxivExplorer's mergeResults.
 *
 * Sort is descending by matchScore, ties broken by keeping the original
 * relative order of first appearance (Array.sort is stable per the ES2019
 * spec, so no explicit tiebreaker needed) -- deliberately NOT falling
 * back to the signal's own persisted score/last_detected_at for tie
 * breaks, since a search-relevance ranking is a different concept from
 * the browse-mode sort orders (score_desc/newest/company_asc) and
 * conflating them would make results reorder unexpectedly if two
 * signals happen to tie on matchScore.
 */
export function mergeSignalMatches<T extends MergeableSignal>(
  keywordMatches: KeywordMatch<T>[],
  semanticMatches: SemanticMatch<T>[],
  limit: number,
): MergedSignalMatch<T>[] {
  const byId = new Map<string, MergedSignalMatch<T>>();

  for (const { signal } of keywordMatches) {
    byId.set(signal.id, {
      signal,
      matchScore: KEYWORD_WEIGHT,
      matchedVia: "keyword",
    });
  }

  for (const { signal, similarity } of semanticMatches) {
    const weighted = similarity * SEMANTIC_WEIGHT;
    const existing = byId.get(signal.id);
    if (existing) {
      existing.matchScore += weighted;
      existing.matchedVia = "both";
    } else {
      byId.set(signal.id, {
        signal,
        matchScore: weighted,
        matchedVia: "semantic",
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, limit);
}
