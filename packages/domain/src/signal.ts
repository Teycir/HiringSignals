import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";

/** Signal types (spec 7.1). Role-level signals are primary; company-level
 * are secondary context shown on the company page only (spec 1.4). */
export const SIGNAL_TYPES = [
  "new_job",
  "reopened_job",
  "hiring_burst",
  "role_acceleration",
  "multi_location",
  "persistent_demand",
] as const;

export const signalTypeSchema = z.enum(SIGNAL_TYPES);
export type SignalType = z.infer<typeof signalTypeSchema>;

export const signalStatusSchema = z.enum(["active", "expired"]);
export type SignalStatus = z.infer<typeof signalStatusSchema>;

/** Bounded 0-100 review-priority score (spec 7.2). Not a probability. */
export const signalScoreSchema = z.number().int().min(0).max(100);

export const signalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  roleCategory: roleCategorySchema,
  signalType: signalTypeSchema,
  status: signalStatusSchema,
  score: signalScoreSchema,
  scoreVersion: z.string(),
  firstDetectedAt: z.string().datetime(),
  lastDetectedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  headline: z.string(),
  summary: z.string(),
});
export type Signal = z.infer<typeof signalSchema>;
