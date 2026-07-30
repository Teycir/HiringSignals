import { Hono } from "hono";
import type { AppEnv, Bindings } from "./bindings";
import { requestId } from "./middleware/request-id";
import { clientIp } from "./middleware/client-ip";
import { securityHeaders } from "./middleware/security-headers";
import { errorHandler } from "./middleware/error-handler";
import { freeReadTier } from "./middleware/anti-abuse";
import { signalsRoute } from "./routes/signals";
import { companiesRoute } from "./routes/companies";
import { sourcesRoute } from "./routes/sources";
import { facetsRoute } from "./routes/facets";
import { adminRoute } from "./routes/admin";
import { handleScheduled } from "./jobs/scheduler";
import { handleIngestMessage } from "./jobs/ingest-consumer";
import { handleReconciliation } from "./jobs/reconciliation";
import type { IngestMessage } from "@hiring-signals/domain";

const app = new Hono<AppEnv>();

// Middleware order follows spec 13.2:
//   1. request id
//   2. client ip + default verdict
//   3. security headers / CORS
//   4. per-route rate limit (anti-abuse tier -- no auth step; every
//      public/user-facing route is unauthenticated by design, spec
//      3/13.5/14.1). /api/v1/admin/* is the one exception (spec
//      13.5a): operator-only, secret-gated via adminAuth(), never
//      reachable from apps/web, never a login a user sees.
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
app.route("/api/v1/sources", sourcesRoute);
app.route("/api/v1/facets", facetsRoute);

// Admin routes: idempotent triggers for the same pipelines the cron
// handlers drive (source-run enqueues a single source, scheduler-flush
// runs the due-source enqueuer, reconcile recomputes stale scores).
// Gated by ADMIN_SECRET via adminAuth() middleware (4-layer defense:
// fail-closed binding check, timingSafeEqual, SHA-256-keyed strike
// counter in ABUSE_LOGS KV, 3-strike / 60s lockout — see
// middleware/admin-auth.ts header comment).
//
// Source write-path management (add/edit source) still lives as a local
// ops script against D1 (infrastructure/scripts/, spec 13.5); admin
// routes only expose scheduling surfaces as idempotent triggers.
app.route("/api/v1/admin", adminRoute);

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
