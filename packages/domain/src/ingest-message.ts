import { z } from "zod";

/** Queue message shape (spec 13.3). Consumer must be idempotent per
 * (sourceId, runId) regardless of `attempt`. */
export const ingestMessageSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().min(1),
  runId: z.string().min(1),
  requestedAt: z.string().datetime(),
  attempt: z.number().int().min(1),
});
export type IngestMessage = z.infer<typeof ingestMessageSchema>;
