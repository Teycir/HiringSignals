import type { Bindings } from "../bindings";
import { createD1Client, getDueSources, hasRecentRunningRun } from "@hiring-signals/db";
import type { IngestMessage } from "@hiring-signals/domain";

/**
 * Cron handler (spec 5.2/13.1). Fires every 15 minutes. Must only:
 *   1. query D1 for sources where enabled=1 AND next_poll_at <= now()
 *   2. enqueue one IngestMessage per due source (with jittered requestedAt)
 *
 * It must NEVER fetch a provider endpoint directly -- that happens only in
 * the queue consumer (jobs/ingest-consumer.ts). Sequential fetching here
 * would blow the 10ms Free-tier CPU-per-cron-invocation limit and defeats
 * the point of decoupling scheduling from fetching via Queues. Enforced by
 * *not importing* any adapter or fetch-capable module into this file at
 * all (ROADMAP.md Milestone D) -- if the import isn't here, it can't be
 * called by accident.
 */

/**
 * Bounds how many due sources one cron invocation processes. The cron
 * fires every 15 minutes regardless of how many sources are due, so a
 * spike in due sources just means the remainder gets picked up on the
 * next tick rather than this invocation trying to enqueue an unbounded
 * number of messages and risking the Free-tier CPU-per-invocation limit
 * (spec §5.2's closing paragraph).
 */
const MAX_SOURCES_PER_TICK = 200;

/**
 * Spreads enqueued messages' requestedAt across this many seconds so
 * sources due at the same tick don't all fire at once (spec §5.2:
 * "deterministic jitter calculated from source_id so sources don't all
 * fire in the same cron tick and spike subrequest usage past the
 * per-invocation cap"). Kept well under the 15-minute cron interval so
 * jitter never pushes a message past the next tick.
 */
const JITTER_SPREAD_SECONDS = 600; // 10 minutes

/**
 * A source with a source_runs row still status='running' and started
 * more recently than this many minutes ago is treated as "already has
 * an in-flight run" and skipped this tick, rather than re-enqueued from
 * chunkOffset 0 (2026-08-13 incident fix -- see hasRecentRunningRun's
 * own doc comment in sources-repo.ts for the full incident writeup:
 * openai's Ashby source accumulated 558 concurrent "running" rows
 * because next_poll_at never advances for a source whose runs never
 * reach success, so getDueSources kept re-selecting it every tick).
 *
 * Set well above one cron interval (15 min) so a large board's
 * legitimate multi-chunk run in progress is never mistaken for
 * abandoned mid-flight -- 45 minutes is 3 full cron ticks' worth of
 * headroom. Tune upward if a real (non-stuck) board's full chunk chain
 * is ever observed taking longer than this.
 */
const RUNNING_RUN_STALE_AFTER_MINUTES = 45;

/**
 * Deterministic, non-cryptographic hash of a source id into a stable
 * jitter offset. Same source_id always produces the same offset (spec's
 * explicit requirement), which also makes this trivially unit-testable:
 * two calls with the same id must return the same value.
 */
function jitterSecondsForSource(sourceId: string): number {
  let hash = 0;
  for (let i = 0; i < sourceId.length; i++) {
    hash = (hash * 31 + sourceId.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return hash % JITTER_SPREAD_SECONDS;
}

export async function handleScheduled(
  _event: ScheduledEvent,
  env: Bindings,
  /**
   * Test-only. Production callers (apps/api/src/index.ts's cron
   * trigger) never pass this -- omitted, createD1Client(env.DB) keeps
   * today's 15s circuit-breaker default. See ROADMAP.md J.2.
   */
  operationTimeoutMs?: number,
): Promise<void> {
  const client = createD1Client(env.DB, { operationTimeoutMs });
  const now = new Date();

  const dueSources = await getDueSources(client, {
    now: now.toISOString(),
    limit: MAX_SOURCES_PER_TICK,
  });

  for (const source of dueSources) {
    try {
      // 2026-08-13 incident fix (see RUNNING_RUN_STALE_AFTER_MINUTES's own
      // comment): a source whose runs never reach success has
      // next_poll_at permanently NULL, so it's re-selected by
      // getDueSources above on every tick -- skip enqueueing a duplicate
      // run while a recent one is still (or plausibly still) in flight,
      // rather than stacking overlapping runs for the same source.
      const alreadyRunning = await hasRecentRunningRun(
        client,
        source.id,
        now.toISOString(),
        RUNNING_RUN_STALE_AFTER_MINUTES,
      );
      if (alreadyRunning) {
        console.warn("scheduler_skip_already_running", { sourceId: source.id });
        continue;
      }

      const jitterSeconds = jitterSecondsForSource(source.id);
      const requestedAt = new Date(now.getTime() + jitterSeconds * 1000).toISOString();

      const message: IngestMessage = {
        version: 1,
        sourceId: source.id,
        runId: crypto.randomUUID(),
        requestedAt,
        attempt: 1,
        chunkOffset: 0,
      };

      // Queue send delaySeconds spreads actual dequeue timing to match the
      // jitter, not just the requestedAt field value -- otherwise every
      // due source's message would still be pulled off the queue in the
      // same burst even though requestedAt differs.
      await env.INGEST_QUEUE.send(message, { delaySeconds: jitterSeconds });
    } catch (error) {
      // One source's check/enqueue failing (a D1 hiccup on
      // hasRecentRunningRun, or a queue-send error) must not abort the
      // rest of this tick's due sources -- same per-item isolation
      // reconciliation.ts's loops already use, so a single bad source
      // doesn't take enqueueing down for every other unrelated due
      // source this tick (they'd still get picked up next tick either
      // way, but no reason to make them wait on an unrelated failure).
      console.error("scheduler_enqueue_failed", {
        sourceId: source.id,
        error_code: error instanceof Error ? error.name : "UnknownError",
        error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
  }
}
