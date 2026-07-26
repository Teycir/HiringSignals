import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { createD1Client, getSignalDetail, listSignals } from "@hiring-signals/db";

// Query schema mirrors spec 9.3. Enforced here even though Phase 0 has no
// D1-backed data yet, so the contract is real from the start.
const signalsQuerySchema = z.object({
  roles: z.string().optional(),
  company: z.string().optional(),
  q: z.string().min(2).optional(),
  locationMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).optional(),
  country: z.string().length(2).optional(),
  source: z.string().optional(),
  signalType: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  observedSince: z.string().optional(),
  sort: z.enum(["score_desc", "newest", "company_asc"]).default("score_desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const signalsRoute = new Hono<AppEnv>();

signalsRoute.get("/", async (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  const result = await listSignals(client, {
    roles: parsed.roles?.split(",").map((r) => r.trim()).filter(Boolean),
    company: parsed.company,
    locationMode: parsed.locationMode,
    country: parsed.country,
    source: parsed.source,
    signalType: parsed.signalType,
    minScore: parsed.minScore,
    observedSince: parsed.observedSince,
    sort: parsed.sort,
    cursor: parsed.cursor,
    limit: parsed.limit,
  });

  return c.json({
    data: result.items,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      nextCursor: result.nextCursor,
    },
  });
});

signalsRoute.get("/:signalId", async (c) => {
  const signalId = c.req.param("signalId");
  const client = createD1Client(c.env.DB);
  const detail = await getSignalDetail(client, signalId);

  if (!detail) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Signal ${signalId} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  return c.json({ data: detail, meta: { requestId: c.get("requestId") } });
});
