import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";

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

signalsRoute.get("/", (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());

  // Phase 1 wires this to packages/db against D1 (spec 8, 9.3).
  return c.json({
    data: [],
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      nextCursor: null,
    },
  });
});

signalsRoute.get("/:signalId", (c) => {
  const signalId = c.req.param("signalId");

  // Phase 1: load signal + signal_evidence rows (spec 8.2, 10.5).
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
});
