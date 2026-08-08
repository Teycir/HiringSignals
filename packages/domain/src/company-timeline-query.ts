import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";

/**
 * Query schema for GET /api/v1/companies/:slug/timeline (ROADMAP.md
 * Milestone O.1, spec §1.4/§10.1). Same "one schema, imported by both
 * the route and the CLI" reasoning as signals-query.ts's header comment
 * -- apps/cli's `hs companies timeline` command imports this symbol
 * directly rather than re-declaring its own flag list.
 *
 * `since`/`until` default inside the route handler (90d-ago/now), not
 * here, since "now" at schema-definition time (module load) would be
 * stale by the time a request actually arrives -- same reason
 * signalsQuerySchema's own dynamic defaults (none currently) would need
 * the same treatment. `bucketDays` defaults here since 14 is a fixed
 * constant, not time-dependent.
 */
export const companyTimelineQuerySchema = z.object({
  roles: roleCategorySchema.optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  // z.coerce.number() first (query params always arrive as strings),
  // then pipe into a literal-union so the inferred type is the exact
  // 7 | 14 | 30 union getCompanyHiringTimeline's bucketDays param
  // expects -- no `as`/`as unknown as` cast needed anywhere in this file.
  bucketDays: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(7), z.literal(14), z.literal(30)]))
    .default(14),
});

export type CompanyTimelineQuery = z.infer<typeof companyTimelineQuerySchema>;
