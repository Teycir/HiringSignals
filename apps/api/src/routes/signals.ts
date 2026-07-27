import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  atsProviderSchema,
  roleCategorySchema,
  signalTypeSchema,
} from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import {
  createD1Client,
  getSignalDetail,
  InvalidCursorError,
  listSignals,
} from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";

// Query schema mirrors spec 9.3. Enforced here even though Phase 0 has no
// D1-backed data yet, so the contract is real from the start.
//
// Enum-valued filters use the *domain* zod schemas directly so this route
// can't drift from the taxonomy: a new signal type or new ATS provider
// only has to be declared in one place (@hiring-signals/domain).
const signalsQuerySchema = z.object({
  roles: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(roleCategorySchema))
    .optional(),
  company: z.string().optional(),
  q: z.string().min(2).optional(),
  locationMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).optional(),
  // spec 9.3: 2-letter uppercase country (ISO 3166-1 alpha-2). Uppercase
  // coercion so clients can send `?country=fr` and still match the DB
  // column which stores uppercase codes.
  country: z
    .string()
    .length(2)
    .transform((code) => code.toUpperCase())
    .optional(),
  source: atsProviderSchema.optional(),
  signalType: signalTypeSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  // Must be a real ISO-8601 datetime: it's compared directly against
  // last_detected_at (TEXT) in the D1 query. Garbage strings used to pass
  // validation and silently produce empty results (`false` on every row
  // comparison) instead of a 400.
  observedSince: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["score_desc", "newest", "company_asc"]).default("score_desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const signalsRoute = new Hono<AppEnv>();
signalsRoute.use("*", freeReadTier());

signalsRoute.get("/", async (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  let result;
  try {
    // `roles` is already parsed + split into a RoleCategory[] array by the
    // schema transform above -- pass it through directly. Everything else
    // is scalar and matches the repo params type.
    result = await listSignals(client, {
      roles: parsed.roles,
      company: parsed.company,
      q: parsed.q,
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
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      // A stale cursor (e.g. sort changed between pages) is a client
      // mistake, not a server fault -- map to 400 like ZodError does,
      // not the default 500 (error-handler.ts).
      throw new HTTPException(400, { message: err.message });
    }
    throw err;
  }

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
