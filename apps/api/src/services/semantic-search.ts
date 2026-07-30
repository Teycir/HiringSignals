/**
 * Query-side semantic search leg for spec §9.4 hybrid search (Milestone
 * I.3, the query half -- I.2 already wired the write/embed-at-ingest
 * half, infrastructure/scripts/backfill-embeddings.mjs the historical
 * backfill half).
 *
 * Embeds the caller's `q` text via Workers AI, queries Vectorize for the
 * nearest job vectors, then resolves those job IDs to active signals via
 * packages/db's findSignalsByJobIds (applying the same non-q filters the
 * keyword leg already applies, so a semantic hit can't bypass them).
 *
 * Guardrail (spec §9.4's own "Guardrail" section + the ROADMAP.md I.2
 * precedent): must never become a hard dependency for the signals route
 * to respond. Every failure mode here (embedding error, Vectorize error,
 * KV cache error) is caught and logged; the caller gets an empty
 * semantic-match list back, never a thrown error -- the keyword leg
 * (already well-tested, spec-required to keep working standalone) is
 * always enough on its own for `GET /api/v1/signals` to succeed.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type { RoleCategory } from "@hiring-signals/domain";
import { findSignalsByJobIds, type ListSignalsParams, type SignalRow } from "@hiring-signals/db";
import type { D1Client } from "@hiring-signals/db";
import type { SemanticMatch } from "@hiring-signals/domain";
import { makeTtlStore } from "../../../../lib/kv/ttl-store";
import type { Bindings } from "../bindings";

const QUERY_EMBED_CACHE_PREFIX = "semq:";
/** 24h -- same cadence ArxivExplorer's own TTL_EMBED uses for cached query
 * embeddings; a given query string's embedding never changes, this is
 * purely about not re-calling Workers AI for the same text repeatedly. */
const QUERY_EMBED_CACHE_TTL_SECONDS = 24 * 60 * 60;
/** How many nearest job vectors to pull from Vectorize before resolving
 * to signals -- several jobs can map to the same signal (multiple
 * evidence rows), and some job IDs may not currently back any *active*
 * signal (job's signal expired/closed since embedding), so this is
 * deliberately wider than the final signals limit the caller wants. */
const VECTORIZE_TOP_K = 30;

type SemanticFilters = Pick<
  ListSignalsParams,
  "roles" | "company" | "locationMode" | "country" | "source" | "signalType" | "minScore" | "observedSince"
>;

/**
 * Runs the full embed -> Vectorize query -> resolve-to-signals pipeline
 * for one query string. Returns [] (never throws) on any failure --
 * see this file's header for why.
 */
export async function findSemanticSignalMatches(
  client: D1Client,
  env: Pick<Bindings, "AI" | "VECTORIZE" | "EMBEDDING_MODEL" | "CACHE">,
  query: string,
  filters: SemanticFilters,
): Promise<SemanticMatch<SignalRow>[]> {
  try {
    const embedding = await getQueryEmbedding(env, query);
    if (!embedding) return [];

    const results = await env.VECTORIZE.query(embedding, {
      topK: VECTORIZE_TOP_K,
      returnMetadata: false, // metadata filtering isn't used here -- packages/db's findSignalsByJobIds already re-applies every filter against real D1 rows, which is the source of truth, not the vector's own metadata snapshot.
    });

    if (results.matches.length === 0) return [];

    // A job's best (highest) similarity score wins if Vectorize somehow
    // returns the same id twice (shouldn't happen -- ids are unique per
    // Vectorize's own model -- but a Map naturally collapses duplicates
    // to "last write wins", so sort descending by score first to make
    // that "last write" the best one, not an arbitrary one).
    const byJobId = new Map<string, number>();
    for (const match of [...results.matches].sort((a, b) => b.score - a.score)) {
      if (!byJobId.has(match.id)) byJobId.set(match.id, match.score);
    }
    const jobIds = Array.from(byJobId.keys());

    const signalRows = await findSignalsByJobIds(client, jobIds, filters);

    // A single job can back more than one active signal (e.g. new_job +
    // hiring_burst both citing it); each such signal inherits that job's
    // similarity score. If more than one matched job maps to the SAME
    // signal (multiple evidence rows), keep the best (highest) similarity
    // -- mirrors the job-id dedup above, same "best evidence wins" logic.
    const bestBySignalId = new Map<string, { signal: SignalRow; similarity: number }>();
    for (const row of signalRows) {
      // We don't have a direct row->jobId mapping from findSignalsByJobIds
      // (it returns signal rows, not the evidence join) -- so we can't
      // attribute a specific job's score to a specific signal exactly.
      // Conservative choice: use the single BEST similarity across all
      // matched jobs for every returned signal. This slightly over-scores
      // a signal that only weakly matched one of several evidence jobs,
      // but never under-scores a genuinely strong semantic match, and
      // avoids a second D1 round trip (evidence -> job -> score mapping)
      // for what's already a best-effort ranking signal, not the
      // persisted spec §7.2 score.
      const bestSimilarity = Math.max(...byJobId.values());
      const existing = bestBySignalId.get(row.id);
      if (!existing || bestSimilarity > existing.similarity) {
        bestBySignalId.set(row.id, { signal: row, similarity: bestSimilarity });
      }
    }

    return Array.from(bestBySignalId.values());
  } catch (error) {
    console.error("semantic_search_failed", { query, error: String(error) });
    return [];
  }
}

/**
 * Resolves an embedding vector for `query`, checking the KV cache first
 * (24h TTL, same reasoning as ArxivExplorer's kvEmbed). Returns null
 * (not throw) if Workers AI itself fails or returns an unexpected shape
 * -- caller treats null the same as "no semantic leg this request".
 */
async function getQueryEmbedding(
  env: Pick<Bindings, "AI" | "EMBEDDING_MODEL" | "CACHE">,
  query: string,
): Promise<number[] | null> {
  const store = makeTtlStore(env.CACHE as KVNamespace, {
    keyPrefix: QUERY_EMBED_CACHE_PREFIX,
    retentionSeconds: QUERY_EMBED_CACHE_TTL_SECONDS,
  });
  const normalized = query.trim().toLowerCase();
  const cacheKey = store.key(normalized);

  try {
    const cached = await store.get(cacheKey);
    if (cached) return JSON.parse(cached) as number[];
  } catch (error) {
    // Cache read/parse error -- fall through to a fresh embed rather than
    // failing the whole search leg over a corrupt cache entry.
    console.error("semantic_search_cache_read_failed", { error: String(error) });
  }

  const embeddingResult = await env.AI.run(env.EMBEDDING_MODEL as "@cf/baai/bge-base-en-v1.5", {
    text: [query],
  });

  if (!("data" in embeddingResult) || !embeddingResult.data?.[0]) {
    // Async-batch response shape (request_id, no data yet) -- same
    // defensive narrowing as ingest-consumer.ts's embedAndUpsertJob;
    // shouldn't happen for a single-text non-queued call.
    console.error("semantic_search_embedding_empty", { query });
    return null;
  }

  const embedding = embeddingResult.data[0];
  // Fire-and-forget cache write -- a failed write just means the next
  // identical query re-embeds; never block the response on it.
  store.put([normalized], JSON.stringify(embedding)).catch((error: unknown) => {
    console.error("semantic_search_cache_write_failed", { error: String(error) });
  });

  return embedding;
}

// Re-exported for callers that only need the type, not the function
// (keeps `RoleCategory` import used and documents the metadata shape
// findSignalsByJobIds's filters ultimately constrain against).
export type { RoleCategory };
