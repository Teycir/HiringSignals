import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

  // D1-outage guard (read-path-hardening-plan.md §4.5): no snapshot
  // domain exists for sources (unlike signal_detail/company_detail/
  // facets), so this stays a clean-failure guard rather than a
  // fallback -- a genuine D1 failure maps to 503 instead of the
  // opaque 500 the route previously had no protection against.
  let results;
  try {
    results = await listSources(client, parsed);
  } catch (err) {
    console.error("D1 query failed for sources:", err);
    throw new HTTPException(503, { message: "Sources listing is temporarily unavailable." });
  }

  return c.json({
    data: results,
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});
