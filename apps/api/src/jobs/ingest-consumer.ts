import type { Message } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings";
import type { IngestMessage } from "@hiring-signals/domain";

/**
 * Queue consumer (spec 5.1/13.3). For one source:
 *   fetch -> validate (adapter Zod schema) -> normalize -> upsert jobs
 *   -> insert observations -> compute lifecycle/signal transitions
 *   -> write raw payload pointer + source_run metrics
 *
 * Must be idempotent per (sourceId, runId): a retry must not create
 * duplicate observations or duplicate signals (spec 13.3).
 *
 * Phase 1 wires this to packages/adapters (fetch+normalize) and
 * packages/db (upserts, lifecycle rules in spec 5.4).
 */
export async function handleIngestMessage(
  message: Message<IngestMessage>,
  _env: Bindings,
): Promise<void> {
  const { sourceId, runId, attempt } = message.body;

  try {
    // TODO(Phase 1): look up source config, call the matching AtsAdapter,
    // validate + normalize, then persist via packages/db.
    console.log("ingest_stub", { sourceId, runId, attempt });
    message.ack();
  } catch (err) {
    console.error("ingest_failed", {
      sourceId,
      runId,
      attempt,
      message: (err as Error)?.message,
    });
    message.retry();
  }
}
