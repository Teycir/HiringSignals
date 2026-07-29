import { Hono } from "hono";
import type { AppEnv, Bindings } from "./bindings";
import { requestId } from "./middleware/request-id";
import { clientIp } from "./middleware/client-ip";
import { securityHeaders } from "./middleware/security-headers";
import { errorHandler } from "./middleware/error-handler";
import { freeReadTier } from "./middleware/anti-abuse";
import { signalsRoute } from "./routes/signals";
import { companiesRoute } from "./routes/companies";
import { facetsRoute } from "./routes/facets";
import { handleScheduled } from "./jobs/scheduler";
import { handleIngestMessage } from "./jobs/ingest-consumer";
import { handleReconciliation } from "./jobs/reconciliation";
import type { IngestMessage } from "@hiring-signals/domain";

const app = new Hono<AppEnv>();

// Middleware order follows spec 13.2:
//   1. request id
//   2. client ip + default verdict
//   3. security headers / CORS
//   4. per-route rate limit (anti-abuse tier -- no auth step; every route
//      is public/unauthenticated by design, spec 3/13.5/14.1)
//   5. zod validation (per-route)
//   6. handler
//   7. structured error mapping
app.use("*", requestId());
app.use("*", clientIp());
app.use("*", securityHeaders());
app.onError(errorHandler);

app.get(
  "/api/v1/health",
  freeReadTier(),
  (c) => c.json({ data: { status: "ok" }, meta: { requestId: c.get("requestId") } }),
);

app.route("/api/v1/signals", signalsRoute);
app.route("/api/v1/companies", companiesRoute);
app.route("/api/v1/facets", facetsRoute);

// No /api/v1/admin mount: source management (add/edit source, manual
// ingestion trigger, health) is a local ops script against D1, not a
// Worker route -- see infrastructure/scripts/ and spec 13.5.

export default {
  fetch: app.fetch,

  // Cron triggers:
  // - every 15 minutes: identify due sources and enqueue ingest work
  // - daily: recompute stale active-signal scores without fetching ATS providers
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === "0 6 * * *") {
      ctx.waitUntil(handleReconciliation(env));
      return;
    }

    ctx.waitUntil(handleScheduled(event, env));
  },

  // Queue consumer: fetches one source, normalizes, persists. Idempotent
  // per (sourceId, runId) so retries never duplicate observations/signals.
  async queue(batch: MessageBatch<IngestMessage>, env: Bindings) {
    for (const message of batch.messages) {
      await handleIngestMessage(message, env);
    }
  },
};
