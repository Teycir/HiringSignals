import { z } from "zod";

/** Queue message shape (spec 13.3). Consumer must be idempotent per
 * (sourceId, runId) regardless of `attempt`.
 *
 * `chunkOffset` (ROADMAP.md G.3/J.4-followup, 2026-08-11): index into
 * the board's normalized job list where this invocation should resume
 * processing. Added after the free-plan default 30s queue-consumer
 * CPU-time limit (distinct from, and not fixed by, J.4's subrequest
 * batching -- see ingest-consumer.ts's own header comment) was found
 * silently killing large-board runs (openai's Ashby board, 739 jobs)
 * mid-invocation with zero log output, leaving the source_runs row
 * stuck at status=\'running\' forever. Defaults to 0 (start of the
 * board) for a fresh run -- every existing call site that doesn\'t set
 * it explicitly (the scheduler\'s first-attempt enqueue, every retry
 * path) is unaffected. A chunked continuation message re-fetches and
 * re-normalizes the board from scratch (cheap: one HTTP GET + JSON
 * parse, see adapter fetchBoard() implementations) rather than trying
 * to persist the normalized list between invocations, then skips ahead
 * to chunkOffset before processing -- see JOBS_PER_CHUNK in
 * ingest-consumer.ts for the chunk size and the full reasoning. */
export const ingestMessageSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().min(1),
  runId: z.string().min(1),
  requestedAt: z.string().datetime(),
  attempt: z.number().int().min(1),
  chunkOffset: z.number().int().min(0).default(0),
});
export type IngestMessage = z.infer<typeof ingestMessageSchema>;
