import { z } from "zod";

/**
 * Path-param schema for GET /api/v1/jobs/:jobId (spec §16.3 "all API
 * input is schema-validated"). `jobs.id` is always a
 * `crypto.randomUUID()` value -- see packages/db/src/jobs-repo.ts's
 * prepareJobUpsert (`const id = crypto.randomUUID()`) -- same
 * `.uuid()` precedent signal-id-param.ts already sets for
 * GET /api/v1/signals/:signalId.
 *
 * Not a security fix -- getJobById already parameterizes its query
 * (`WHERE id = ?`), so a malformed id was never an injection risk, only
 * an unvalidated 404-vs-400 gap.
 */
export const jobIdParamSchema = z.object({
  jobId: z.string().uuid(),
});

export type JobIdParam = z.infer<typeof jobIdParamSchema>;
