import type { Bindings } from "../bindings";

/**
 * Cron handler (spec 5.2/13.1). Fires every 15 minutes. Must only:
 *   1. query D1 for sources where enabled=1 AND next_poll_at <= now()
 *   2. enqueue one IngestMessage per due source (with jittered requestedAt)
 *
 * It must NEVER fetch a provider endpoint directly -- that happens only in
 * the queue consumer (jobs/ingest-consumer.ts). Sequential fetching here
 * would blow the 10ms Free-tier CPU-per-cron-invocation limit and defeats
 * the point of decoupling scheduling from fetching via Queues.
 *
 * Phase 1 implements the actual D1 query + enqueue loop + deterministic
 * jitter derived from source_id (spec 5.2).
 */
export async function handleScheduled(_event: ScheduledEvent, _env: Bindings): Promise<void> {
  // TODO(Phase 1): SELECT due sources from D1, enqueue INGEST_QUEUE messages.
}
