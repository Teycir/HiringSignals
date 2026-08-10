import { z } from "zod";

/**
 * Path-param schema for GET /api/v1/signals/:signalId (spec §16.3 "all
 * API input is schema-validated"). `signals.id` is always a
 * `crypto.randomUUID()` value -- see packages/db/src/signals-write-repo.ts
 * (both insert sites) -- so `.uuid()` rejects a malformed id with a clean
 * 400 before it ever reaches getSignalDetail, mirroring the precedent
 * apps/api/src/routes/admin.ts already sets for `:sourceId` via
 * sourceIdParamSchema.
 *
 * Not a security fix -- getSignalDetail already parameterizes every query
 * (`WHERE s.id = ?`), so a malformed id was never an injection risk, only
 * an unvalidated 404-vs-400 gap.
 */
export const signalIdParamSchema = z.object({
  signalId: z.string().uuid(),
});

export type SignalIdParam = z.infer<typeof signalIdParamSchema>;
