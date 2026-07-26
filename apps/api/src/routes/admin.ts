import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../bindings";

const addSourceSchema = z.object({
  companySlug: z.string().min(1),
  provider: z.enum([
    "greenhouse",
    "lever",
    "ashby",
    "smartrecruiters",
    "workable",
    "recruitee",
    "personio",
    "teamtailor",
    "jazzhr",
    "breezy",
    "bamboohr",
  ]),
  boardToken: z.string().min(1),
  publicUrl: z.string().url(),
  pollIntervalMinutes: z.number().int().min(1).optional(),
});

const patchSourceSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(1).optional(),
});

export const adminRoute = new Hono<AppEnv>();

// TODO(spec 14.1): gate every route below with Cloudflare Access / role-based
// auth before any production deployment. Deliberately unguarded placeholder
// during Phase 0 scaffolding only -- do not deploy this file as-is.
adminRoute.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production") {
    throw new HTTPException(401, { message: "Admin auth not yet configured." });
  }
  await next();
});

adminRoute.post("/sources", async (c) => {
  const body = addSourceSchema.parse(await c.req.json());
  // Phase 1: insert into `sources` (spec 8.2) after validating the company exists.
  return c.json({ data: { accepted: true, source: body }, meta: { requestId: c.get("requestId") } }, 201);
});

adminRoute.patch("/sources/:id", async (c) => {
  const body = patchSourceSchema.parse(await c.req.json());
  return c.json({
    data: { id: c.req.param("id"), updated: body },
    meta: { requestId: c.get("requestId") },
  });
});

adminRoute.post("/ingestion/run", async (c) => {
  // Phase 1: enqueue a single IngestMessage for the given sourceId (spec 13.3).
  return c.json({ data: { enqueued: false }, meta: { requestId: c.get("requestId") } });
});

adminRoute.get("/health", (c) => {
  // Source/ingestion-health summary table (spec 16.2).
  return c.json({ data: { sources: [] }, meta: { requestId: c.get("requestId") } });
});
