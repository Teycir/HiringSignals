import { Hono } from "hono";
import { jobIdParamSchema } from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import { createD1Client, getJobById } from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";

/**
 * Single-job detail (new -- see companies.ts's ":slug/jobs" route for
 * the full rationale: nothing before this exposed the `jobs` table
 * directly). Same shape as GET /api/v1/signals/:signalId: a validated
 * UUID path param (jobIdParamSchema, mirroring signalIdParamSchema),
 * 404 with the standard error envelope when the id doesn't resolve,
 * otherwise the full JobDetail (JobListItem's fields plus description,
 * raw location, role tags, classification version, and an
 * observationCount derived from job_observations).
 *
 * Mounted at the bare /api/v1/jobs prefix in index.ts -- a standalone
 * top-level resource, not nested under companies/:slug, since a job is
 * looked up by its own id and the caller doesn't necessarily know which
 * company it belongs to in advance (e.g. following a canonicalUrl or an
 * id surfaced elsewhere).
 */
export const jobsRoute = new Hono<AppEnv>();
jobsRoute.use("*", freeReadTier());

jobsRoute.get("/:jobId", async (c) => {
  const { jobId } = jobIdParamSchema.parse({ jobId: c.req.param("jobId") });
  const client = createD1Client(c.env.DB);
  const detail = await getJobById(client, jobId);

  if (!detail) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Job ${jobId} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  return c.json({ data: detail, meta: { requestId: c.get("requestId") } });
});
