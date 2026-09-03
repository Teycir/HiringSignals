/**
 * Admin routes (spec 10.5, ROADMAP Milestone admin-routes).
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

/**
 * Fixed allow-list of live-D1 test-suite company slug prefixes (one per
 * packages/db/test/*.ts and apps/api/test/jobs/*.ts file's own
 * `TEST_PREFIX` constant, 2026-09-03 prod-pollution incident). Every one
 * of these files already has its own `finally`/`afterAll` cleanup that
 * deletes rows matching `${TEST_PREFIX}-%` in FK-safe order -- this route
 * exists only because an interrupted run (the D1-quota chaos during
 * today's incident) can kill a test process before its `afterAll` sweep
 * fires, leaving orphaned rows behind in production D1.
 *
 * Deliberately NOT a caller-supplied pattern: accepting an arbitrary
 * LIKE pattern in an admin request body would turn a cleanup tool into a
 * mass-delete primitive. Only these known-safe prefixes are ever eligible.
 */
const TEST_DATA_PREFIXES = [
  "test-cr",
  "test-crs",
  "test-jrp",
  "test-ser",
  "test-sr",
  "test-swr",
  "test-src",
  "test-trends",
  "test-ic",
  "test-recon",
  "test-sched",
] as const;

const testDataCleanupBodySchema = z.object({
  confirm: z.boolean().optional().default(false),
});

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
 * runId — see ingest-consumer.ts header comment, spec §10.3).
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
    chunkOffset: 0,
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

/**
 * POST /api/v1/admin/test-data/cleanup
 *
 * One-off remediation for the 2026-09-03 prod-pollution incident:
 * deletes any company (and its FK-dependent rows) whose slug matches one
 * of TEST_DATA_PREFIXES above, using the Worker's own `env.DB` binding
 * rather than the wrangler CLI's admin-API query path -- the two draw
 * from separate D1 quotas (confirmed during the incident: the CLI path
 * was exhausted while live Worker-bound queries kept succeeding), so
 * this route works even when `wrangler d1 execute --remote` is walled
 * off for the rest of the UTC day.
 *
 * Defaults to a dry run (counts only, no deletes) unless the request
 * body sets `"confirm": true` -- mirrors the cleanup discipline already
 * in every live-D1 test file's own cleanupCompany()/afterAll sweep
 * (signal_evidence -> signals -> jobs -> source_runs -> sources ->
 * companies), just invoked out-of-band instead of from a test's own
 * teardown. One batch() call per prefix (D1's real transaction
 * primitive) so a mid-sequence failure can't leave one prefix
 * half-deleted while still processing the rest independently.
 */
adminRoute.post("/test-data/cleanup", async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = testDataCleanupBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      {
        error: "invalid_body",
        message: "Body must be JSON with an optional boolean `confirm` field.",
        meta: { requestId: c.get("requestId") },
      },
      400,
    );
  }
  const { confirm } = parsedBody.data;

  const client = createD1Client(c.env.DB);
  const results: Array<{ prefix: string; companies: number; deleted: boolean }> = [];

  for (const prefix of TEST_DATA_PREFIXES) {
    const pattern = `${prefix}-%`;
    const countRow = await client.first<{ n: number }>(
      `SELECT COUNT(*) as n FROM companies WHERE slug LIKE ?`,
      [pattern],
    );
    const n = countRow?.n ?? 0;

    if (n > 0 && confirm) {
      await client.batch([
        {
          sql: `DELETE FROM signal_evidence WHERE signal_id IN (
             SELECT id FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
           )`,
          params: [pattern],
        },
        {
          sql: `DELETE FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
          params: [pattern],
        },
        {
          sql: `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
          params: [pattern],
        },
        {
          sql: `DELETE FROM source_runs WHERE source_id IN (
             SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
           )`,
          params: [pattern],
        },
        {
          sql: `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
          params: [pattern],
        },
        { sql: `DELETE FROM companies WHERE slug LIKE ?`, params: [pattern] },
      ]);
    }

    results.push({ prefix, companies: n, deleted: n > 0 && confirm });
  }

  const totalCompanies = results.reduce((sum, r) => sum + r.companies, 0);

  return c.json({
    data: {
      dryRun: !confirm,
      totalMatchedCompanies: totalCompanies,
      byPrefix: results,
      note: confirm
        ? "Matched rows deleted (FK-safe order, one batch() per prefix)."
        : "Dry run only -- no rows deleted. Resend with {\"confirm\": true} to delete.",
    },
    meta: { requestId: c.get("requestId") },
  });
});
