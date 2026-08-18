import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";
import { locationModeSchema, jobStatusSchema } from "./job";

/**
 * Query schema for GET /api/v1/companies/:slug/jobs -- the raw per-job
 * listing signals-query.ts's signalsQuerySchema never exposed (signals
 * are derived events over jobs, not the jobs themselves; see this
 * route's own header comment in apps/api/src/routes/companies.ts for the
 * full "why this exists" rationale). `company` is implicit here (it's
 * the `:slug` path param, not a query field) -- everything else mirrors
 * signalsQuerySchema's shape/defaults/error behavior so a caller already
 * familiar with `hs signals list` doesn't have to learn a second
 * convention for `hs companies jobs`.
 *
 * `roles`/`locationMode` mirror signals-query.ts exactly (same comma-
 * separated-array-with-min(1) fix for `roles`, same enum for
 * locationMode). `status` defaults to "active" (not "any") since the
 * primary use case is "what's currently open at this company" --
 * closed/possibly_closed jobs are still queryable via an explicit
 * ?status= for historical/audit lookups, not hidden entirely.
 */
export const jobsQuerySchema = z.object({
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
  locationMode: locationModeSchema.optional(),
  status: jobStatusSchema.default("active"),
  sort: z.enum(["newest", "oldest", "title_asc"]).default("newest"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type JobsQuery = z.infer<typeof jobsQuerySchema>;
