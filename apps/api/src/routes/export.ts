import { Hono } from "hono";
import { z } from "zod";
import { atsProviderSchema, roleCategorySchema, signalTypeSchema } from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import { createD1Client, listSignalsForExport, type SignalExportRow } from "@hiring-signals/db";
import { toCsvDocument } from "../../../../lib/text/csv";
import { freeReadTier } from "../middleware/anti-abuse";

/**
 * Milestone L.1 (ROADMAP.md), spec §2.1 (P0), §9.2 (route listed),
 * §8.3 (export artifacts -- this route generates the CSV on demand from
 * live D1 data per request; it does not persist/cache the file in KV
 * itself, so §8.3's "expire after 24h" retention note doesn't apply to
 * anything this route writes).
 *
 * Query schema intentionally mirrors signalsQuerySchema (routes/signals.ts)
 * MINUS sort/cursor/limit -- export is a single capped dump
 * (packages/db's EXPORT_ROW_CAP, v1 = 2000 rows) in a fixed score_desc-
 * equivalent order, not a paginated feed (see listSignalsForExport's own
 * header comment for why). Duplicating the schema here (rather than
 * importing signalsQuerySchema and `.omit()`-ing) keeps this route's
 * contract legible on its own -- omitting fields from an imported schema
 * would still leave a reader needing to open signals.ts to know what's
 * actually accepted.
 */
const exportQuerySchema = z.object({
  // `.min(1)` bug fix (see signals-query.ts's signalsQuerySchema.roles
  // for the original fix + full rationale): this schema is a deliberate
  // hand-copy of that one (see this const's own header comment on why),
  // which meant it did NOT inherit the fix when signalsQuerySchema was
  // patched -- a provided-but-empty `?roles=` or `?roles=,` on this
  // route silently parsed as `[]`, which listSignalsForExport's shared
  // buildCommonFilters (`params.roles?.length`) treats identically to
  // "no filter," dumping every role instead of erroring on the caller's
  // malformed input. Same fix, same reasoning, applied here since this
  // schema is a separate object, not an import.
  roles: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(roleCategorySchema).min(1))
    .optional(),
  company: z.string().optional(),
  q: z.string().min(2).optional(),
  locationMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).optional(),
  country: z
    .string()
    .length(2)
    .transform((code) => code.toUpperCase())
    .optional(),
  source: atsProviderSchema.optional(),
  signalType: signalTypeSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  observedSince: z.string().datetime({ offset: true }).optional(),
});

// Column order is part of the contract (ROADMAP.md L.1) -- consumers
// (investors/recruiters per spec §1.2) may script against fixed column
// positions, so this order must not silently change once shipped.
const CSV_HEADER = [
  "signal_id",
  "signal_type",
  "score",
  "company_name",
  "role_category",
  "headline",
  "location_mode",
  "country_code",
  "first_detected_at",
  "last_detected_at",
  "source_platform",
  "canonical_url",
];

/**
 * location_mode/country_code/canonical_url/source_platform all come from
 * `listSignalsForExport`'s representative-job resolution (see that
 * function's header comment in signals-repo.ts) -- null on any row for a
 * company-level signal whose evidence never references a specific job
 * (Milestone H.4 aggregate signals), rendered by toCsvDocument as an
 * empty cell, not an error.
 */
function toCsvRow(row: SignalExportRow): Array<string | number | null> {
  return [
    row.id,
    row.signal_type,
    row.score,
    row.company_display_name,
    row.role_category,
    row.headline,
    row.location_mode,
    row.country_code,
    row.first_detected_at,
    row.last_detected_at,
    row.source_platform,
    row.canonical_url,
  ];
}

export const exportRoute = new Hono<AppEnv>();
exportRoute.use("*", freeReadTier());

exportRoute.get("/signals.csv", async (c) => {
  const parsed = exportQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  const result = await listSignalsForExport(client, {
    roles: parsed.roles,
    company: parsed.company,
    q: parsed.q,
    locationMode: parsed.locationMode,
    country: parsed.country,
    source: parsed.source,
    signalType: parsed.signalType,
    minScore: parsed.minScore,
    observedSince: parsed.observedSince,
  });

  const csv = toCsvDocument(CSV_HEADER, result.items.map(toCsvRow));

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="hiring-signals-export.csv"');
  c.header("Cache-Control", "no-store");
  if (result.truncated) {
    c.header("X-Export-Truncated", "true");
  }

  return c.body(csv);
});
