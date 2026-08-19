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
      // "none" (string enum), not `false` -- the Workers binding proxy
      // mis-serializes the boolean `false` for returnMetadata into the
      // Vectorize API request body, causing every query() call to fail
      // (confirmed 2026-08-19 via wrangler dev + `wrangler vectorize
      // query --return-metadata=none`, which works correctly against
      // the same index/vector). Semantically identical to `false` --
      // metadata filtering isn't used here regardless, since
      // packages/db's findSignalsByJobIds already re-applies every
      // filter against real D1 rows, the source of truth, not the
      // vector's own metadata snapshot.
      returnMetadata: "none",
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
    //
    // findSignalsByJobIds now returns row.matched_job_id -- one job_id
    // (from our own jobIds set) that actually backs this specific signal
    // -- so we look up THAT job's real Vectorize score in byJobId, rather
    // than the previous (buggy) Math.max(...byJobId.values()), which
    // ignored `row` entirely and gave every returned signal the same
    // global-best score regardless of which job actually matched it.
    // Fallback to 0 only defends against a missing/unmapped
    // matched_job_id (shouldn't happen given findSignalsByJobIds's own
    // WHERE-IN scoping, but never crash the semantic leg over it -- see
    // this file's header on the never-throw contract).
    const bestBySignalId = new Map<string, { signal: SignalRow; similarity: number }>();
    for (const row of signalRows) {
      const similarity = row.matched_job_id ? (byJobId.get(row.matched_job_id) ?? 0) : 0;
      const existing = bestBySignalId.get(row.id);
      if (!existing || similarity > existing.similarity) {
        bestBySignalId.set(row.id, { signal: row, similarity });
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

/** How many nearest job vectors to pull for a `like` lookup before
 * excluding the source job and resolving to signals -- +1 over
 * VECTORIZE_TOP_K's role in the `q` leg above, since one slot is always
 * spent on the source job matching itself (cosine similarity 1.0
 * against its own vector), which gets filtered out below. */
const LIKE_VECTORIZE_TOP_K = VECTORIZE_TOP_K + 1;

/** Thrown when `jobId` has no stored Vectorize vector -- distinct from
 * this file's other functions' never-throw contract: spec 9.4's query
 * contract for capability 3 requires a 404 here specifically, since
 * "this job was never embedded" is a genuine, useful answer to give the
 * caller, not a condition that should degrade to an empty result the
 * way a `q` search's semantic leg does. signals.ts's route handler
 * catches this one error type and maps it to a 404; every other failure
 * inside this function still degrades silently, per this file's header. */
export class JobNotEmbeddedError extends Error {
  constructor(public readonly jobId: string) {
    super(`No stored vector for job ${jobId}`);
    this.name = "JobNotEmbeddedError";
  }
}

/**
 * Id-based "similar signals" lookup (spec §9.4 capability 3, added
 * 2026-08-19) -- resolves `jobId`'s own stored Vectorize vector via
 * getByIds, queries nearest neighbours from that vector (not a
 * re-embedded text query), excludes the source job, then resolves the
 * neighbour job ids to active signals via the same findSignalsByJobIds
 * capability 1's semantic leg already uses. Mirrors ArxivExplorer's
 * handleMoreLikeThis (src/api-worker/routes/search.ts) -- same
 * getByIds -> query -> exclude-source -> resolve shape, ported to
 * signals instead of papers.
 *
 * Takes no filters (unlike findSemanticSignalMatches above) -- spec
 * 9.4's query contract for capability 3 is explicit that
 * roles/company/locationMode/etc. are ignored when `like` is present,
 * same as ArxivExplorer's handleMoreLikeThis takes none either.
 *
 * Throws JobNotEmbeddedError (only) if `jobId` has no stored vector --
 * see that class's own comment for why this one case doesn't follow
 * this file's usual never-throw contract. Every other failure mode
 * (Vectorize query error, D1 error) is caught and logged, returning []
 * -- same posture as findSemanticSignalMatches for those.
 */
export async function findSimilarSignalsByJobId(
  client: D1Client,
  env: Pick<Bindings, "VECTORIZE">,
  jobId: string,
): Promise<SemanticMatch<SignalRow>[]> {
  const sourceVectors = await env.VECTORIZE.getByIds([jobId]);

  if (!sourceVectors.length || !sourceVectors[0]?.values) {
    throw new JobNotEmbeddedError(jobId);
  }

  const sourceEmbedding = sourceVectors[0].values as number[];

  try {
    const results = await env.VECTORIZE.query(sourceEmbedding, {
      topK: LIKE_VECTORIZE_TOP_K,
      // "none", not `false` -- see findSemanticSignalMatches's query()
      // call above for the binding-proxy serialization bug this works
      // around. Same reasoning otherwise: findSignalsByJobIds re-applies
      // real D1 state, not a vector metadata snapshot.
      returnMetadata: "none",
    });

    if (results.matches.length === 0) return [];

    // Exclude the source job itself (it always matches its own vector
    // at score 1.0) -- mirrors ArxivExplorer's handleMoreLikeThis
    // filtering out the source paperId the same way.
    const byJobId = new Map<string, number>();
    for (const match of [...results.matches].sort((a, b) => b.score - a.score)) {
      if (match.id === jobId) continue;
      if (!byJobId.has(match.id)) byJobId.set(match.id, match.score);
    }
    const neighbourJobIds = Array.from(byJobId.keys());
    if (neighbourJobIds.length === 0) return [];

    // No filters passed through (spec 9.4 capability 3: `like` ignores
    // roles/company/locationMode/etc.) -- minScore is the one field on
    // ListSignalsParams that isn't optional at the type level (it has a
    // schema `.default(0)` at the input boundary, but the parsed type
    // requires it), so 0 (the same value that default resolves to) is
    // passed explicitly rather than omitted. observedSince is passed
    // explicitly too (epoch floor), for the same "isn't really optional"
    // reason but from the other direction: buildCommonFilters
    // (signals-repo.ts) silently defaults an omitted observedSince to
    // "last 30 days", which is a real, active filter, not a no-op --
    // leaving it out here would mean a `like` neighbour whose only
    // active signal is >30 days stale silently vanishes from a
    // capability spec 9.4 explicitly says takes NO filters. A fixed
    // epoch floor (not "just old enough") makes the intent -- no time
    // bound at all -- explicit rather than relying on today's data
    // happening to fall inside 30 days to hide the gap (as it did until
    // this was caught in a 2026-08-19 live smoke test).
    const signalRows = await findSignalsByJobIds(client, neighbourJobIds, {
      minScore: 0,
      observedSince: new Date(0).toISOString(),
    });

    // Same best-score-wins dedup as findSemanticSignalMatches, for the
    // same reason (a signal can have multiple evidence jobs, more than
    // one of which may appear among the neighbours).
    const bestBySignalId = new Map<string, { signal: SignalRow; similarity: number }>();
    for (const row of signalRows) {
      const similarity = row.matched_job_id ? (byJobId.get(row.matched_job_id) ?? 0) : 0;
      const existing = bestBySignalId.get(row.id);
      if (!existing || similarity > existing.similarity) {
        bestBySignalId.set(row.id, { signal: row, similarity });
      }
    }

    return Array.from(bestBySignalId.values());
  } catch (error) {
    console.error("similar_signals_lookup_failed", { jobId, error: String(error) });
    return [];
  }
}

// Re-exported for callers that only need the type, not the function
// (keeps `RoleCategory` import used and documents the metadata shape
// findSignalsByJobIds's filters ultimately constrain against).
export type { RoleCategory };
