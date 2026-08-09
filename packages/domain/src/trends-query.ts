import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";

/**
 * Query schema for GET /api/v1/trends/hiring (ROADMAP.md Milestone
 * P.2, spec §1.2/§2.3). Same "one schema, imported by both the route
 * and the CLI" reasoning as signals-query.ts/company-timeline-query.ts's
 * header comments -- apps/cli's `hs trends hiring` command (P.3) will
 * import this symbol directly.
 *
 * `roles` reuses signals-query.ts's exact comma-delimited-string ->
 * array-of-roleCategorySchema transform, required here (>=1, not
 * optional) per P.2's own "roles (comma-delimited, required >=1)"
 * wording -- a cross-company trend query with no role filter at all
 * would aggregate every role category into one ranking, which isn't
 * the "which fintechs started hiring ML" use case this endpoint exists
 * for.
 *
 * `since` defaults inside the route handler (30d-ago), not here, same
 * reasoning as company-timeline-query.ts's header comment: "now" at
 * schema-module-load time would be stale by request time.
 */
export const trendsQuerySchema = z.object({
  roles: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(roleCategorySchema).min(1)),
  industry: z.string().min(1).optional(),
  // 2-letter uppercase country (ISO 3166-1 alpha-2), same coercion as
  // signals-query.ts's `country` field so `?country=de` matches the
  // uppercase-stored column.
  country: z
    .string()
    .length(2)
    .transform((code) => code.toUpperCase())
    .optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z
    .enum(["acceleration_desc", "volume_desc", "newest_signal", "velocity_desc"])
    .default("acceleration_desc"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type TrendsQuery = z.infer<typeof trendsQuerySchema>;
