import { Hono } from "hono";
import { z } from "zod";
import { atsProviderSchema } from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import { freeReadTier, protectedWriteTier } from "../middleware/anti-abuse";

const addSourceSchema = z.object({
  companySlug: z.string().min(1),
  provider: atsProviderSchema,
  boardToken: z.string().min(1),
  publicUrl: z.string().url(),
  pollIntervalMinutes: z.number().int().min(1).optional(),
});

const patchSourceSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(1).optional(),
});

export const adminRoute = new Hono<AppEnv>();

adminRoute.post(
  "/sources",
  protectedWriteTier({ action: "admin-source-create" }),
  async (c) => {
    const body = addSourceSchema.parse(await c.req.json());
    return c.json(
      { data: { accepted: true, source: body }, meta: { requestId: c.get("requestId") } },
      201,
    );
  },
);

adminRoute.patch(
  "/sources/:id",
  protectedWriteTier({ action: "admin-source-update" }),
  async (c) => {
    const body = patchSourceSchema.parse(await c.req.json());
    return c.json({
      data: { id: c.req.param("id"), updated: body },
      meta: { requestId: c.get("requestId") },
    });
  },
);

adminRoute.post(
  "/ingestion/run",
  protectedWriteTier({ action: "admin-ingestion-run" }),
  async (c) => {
    return c.json({ data: { enqueued: false }, meta: { requestId: c.get("requestId") } });
  },
);

adminRoute.get("/health", freeReadTier(), (c) => {
  return c.json({ data: { sources: [] }, meta: { requestId: c.get("requestId") } });
});
