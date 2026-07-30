import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { createD1Client, listSources } from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";

const sourcesQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const sourcesRoute = new Hono<AppEnv>();
sourcesRoute.use("*", freeReadTier());

sourcesRoute.get("/", async (c) => {
  const parsed = sourcesQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const results = await listSources(client, parsed);

  return c.json({
    data: results,
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});
