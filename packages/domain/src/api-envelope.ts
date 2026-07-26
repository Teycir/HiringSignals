import { z } from "zod";

/** Stable success/error envelopes every API response uses (spec 9.1). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function successEnvelope<T>(data: T, meta: Record<string, unknown> = {}) {
  return { data, meta };
}
