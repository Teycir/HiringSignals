import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";
import { signalTypeSchema } from "./signal";
import { atsProviderSchema } from "./providers";

/**
 * Query schema for GET /api/v1/signals (spec 9.3). Moved here from
 * apps/api/src/routes/signals.ts (ROADMAP.md Milestone F.1.1) so
 * apps/cli can import the *exact* schema the API enforces instead of
 * re-declaring its own flag list that could silently drift out of sync
 * with the live route -- a new filter field only has to be added here
 * once, and both the route and the CLI pick it up. The route re-exports
 * this symbol rather than defining its own, so `signalsRoute` and `hs
 * signals list` are provably validating against the same contract.
 *
 * Enum-valued filters use the domain zod schemas directly (roleCategorySchema,
 * atsProviderSchema, signalTypeSchema) for the same reason: a new signal
 * type or ATS provider only has to be declared in one place.
 */
export const signalsQuerySchema = z.object({
  // `.min(1)` on the piped array (not on the raw string) mirrors
  // trends-query.ts's identical roles field: it rejects a *provided but
  // empty* value (`?roles=` or `?roles=,`, which split/trim/filter would
  // otherwise silently collapse to []) with a clear Zod error, while an
  // *omitted* `roles` key still means "no role filter" -- `.optional()`
  // wraps the whole chain, so it short-circuits before this ever runs
  // when the key is absent entirely. Bug fix: before this, roles=","
  // (or roles="") passed validation as `[]`, which listSignals'
  // buildCommonFilters (`params.roles?.length`) treats identically to
  // "no filter" -- so a caller who *meant* to filter by role instead
  // silently got every role back, with no error to say why. `hs signals
  // list --role ','` demonstrated this before the fix.
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
  // 2-letter uppercase country (ISO 3166-1 alpha-2). Uppercase coercion so
  // clients can send `?country=fr` and still match the DB column which
  // stores uppercase codes.
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

export type SignalsQuery = z.infer<typeof signalsQuerySchema>;
