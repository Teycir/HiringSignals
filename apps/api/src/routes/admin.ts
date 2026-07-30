/**
 * Admin routes (spec 13.5, ROADMAP Milestone admin-routes).
 *
 * Three idempotent trigger surfaces. source-run enqueues a single source
 * immediately; scheduler-flush and reconcile delegate to the same named
 * pipeline functions the cron handlers use (jobs/scheduler.ts,
 * jobs/reconciliation.ts) — those pipelines enforce their own internal
 * batch limits (200 sources / 200 signals) for CPU-budget safety.
 *
 * All three routes go through adminAuth() middleware: fail-closed secret
 * check, timingSafeEqual comparison, SHA-256-keyed strike counter in
 * ABUSE_LOGS KV, 3-strike / 60s lockout (see middleware/admin-auth.ts).
 *
 * Write-scope enforcement: repo-level UPDATE/DELETE operations still
 * include company_id qualifiers — admin auth does NOT bypass IDOR guards.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { adminAuth } from "../middleware/admin-auth";
import { createD1Client, getSourceById } from "@hiring-signals/db";
import { handleScheduled } from "../jobs/scheduler";
import { handleReconciliation } from "../jobs/reconciliation";
import type { IngestMessage } from "@hiring-signals/domain";

const sourceIdParamSchema = z.object({
  sourceId: z.string().uuid(),
});

export const adminRoute = new Hono<AppEnv>();
adminRoute.use("*", adminAuth());

/**
 * POST /api/v1/admin/sources/:sourceId/run
 *
 * Immediately enqueue one source for ingestion, bypassing its polling
 * schedule. A new runId is minted per call, so repeated calls produce
 * separate runs (idempotency lives at the *consumer* level keyed on
 * runId — see ingest-consumer.ts header comment, spec §13.3).
 *
 * Never fetches the provider inline: enqueues only.
 */
adminRoute.post("/sources/:sourceId/run", async (c) => {
  const parsedParams = sourceIdParamSchema.safeParse({
    sourceId: c.req.param("sourceId"),
  });
  if (!parsedParams.success) {
    return c.json(
      {
        error: "invalid_source_id",
        message: "sourceId must be a valid UUID.",
        meta: { requestId: c.get("requestId") },
      },
      400,
    );
  }
  const { sourceId } = parsedParams.data;

  const client = createD1Client(c.env.DB);
  const source = await getSourceById(client, sourceId);

  if (!source) {
    return c.json(
      {
        error: "not_found",
        message: `No source with id="${sourceId}" exists.`,
        meta: { requestId: c.get("requestId") },
      },
      404,
    );
  }

  if (!source.enabled) {
    return c.json(
      {
        error: "source_disabled",
        message: `Source id="${sourceId}" is disabled; enable it before triggering a run.`,
        meta: { requestId: c.get("requestId"), sourceId, companyId: source.company_id },
      },
      409,
    );
  }

  const now = new Date();
  const runId = crypto.randomUUID();
  const message: IngestMessage = {
    version: 1,
    sourceId,
    runId,
    requestedAt: now.toISOString(),
    attempt: 1,
  };

  await c.env.INGEST_QUEUE.send(message);

  return c.json({
    data: {
      enqueued: true,
      sourceId,
      runId,
      companyId: source.company_id,
      provider: source.provider,
      requestedAt: message.requestedAt,
    },
    meta: { requestId: c.get("requestId") },
  });
});

/**
 * POST /api/v1/admin/scheduler/flush
 *
 * Run the 15-minute cron's scheduler pass out-of-band: query D1 for due
 * sources and enqueue them exactly as handleScheduled would. Internal
 * batch cap is 200 sources per flush (MAX_SOURCES_PER_TICK in
 * scheduler.ts); the remainder is picked up on subsequent calls or the
 * next cron tick.
 */
adminRoute.post("/scheduler/flush", async (c) => {
  const now = new Date();
  const fakeCronEvent = {
    cron: "*/15 * * * *",
    scheduledTime: now.toISOString(),
    type: "scheduled",
  } as unknown as ScheduledEvent;

  const promise = handleScheduled(fakeCronEvent, c.env);
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(promise);
  } else {
    await promise;
  }

  return c.json({
    data: {
      flushed: true,
      scheduledAt: now.toISOString(),
      batchLimit: 200,
      note: "Enqueues up to 200 due sources per flush; repeat for remainder or wait for the cron.",
    },
    meta: { requestId: c.get("requestId") },
  });
});

/**
 * POST /api/v1/admin/reconcile
 *
 * Trigger the daily stale-signal score reconciliation pass out-of-band.
 * Internal batch cap is 200 signals per run (MAX_SIGNALS_PER_RUN in
 * reconciliation.ts). Runs synchronously within the request via
 * waitUntil because it only touches D1 — no upstream network calls.
 */
adminRoute.post("/reconcile", async (c) => {
  const now = new Date();
  const promise = handleReconciliation(c.env, now);
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(promise);
  } else {
    await promise;
  }

  return c.json({
    data: {
      reconciled: true,
      startedAt: now.toISOString(),
      batchLimit: 200,
      note: "Reconciles up to 200 stale signals per run; repeat for remainder or wait for the daily cron.",
    },
    meta: { requestId: c.get("requestId") },
  });
});
