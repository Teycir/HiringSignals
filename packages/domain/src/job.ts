import { z } from "zod";
import { roleCategorySchema } from "./role-taxonomy";

export const locationModeSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type LocationMode = z.infer<typeof locationModeSchema>;

/**
 * Canonical shape every AtsAdapter.normalize() must return (spec 5.3).
 * This is the contract boundary between "whatever a provider's API returns"
 * and everything downstream (lifecycle, classification, signals).
 */
export const normalizedJobSchema = z.object({
  externalJobId: z.string().min(1),
  canonicalUrl: z.string().url(),
  title: z.string().min(1),
  descriptionText: z.string().optional(),
  department: z.string().optional(),
  employmentType: z.string().optional(),
  locationRaw: z.string().optional(),
  locationMode: locationModeSchema.optional(),
  postedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  requisitionId: z.string().optional(),
});
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

export const jobStatusSchema = z.enum(["active", "possibly_closed", "closed"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Job record classification fields (spec 6.2). */
export const jobClassificationSchema = z.object({
  rolePrimary: roleCategorySchema.optional(),
  roleTags: z.array(roleCategorySchema).default([]),
  classificationConfidence: z.number().min(0).max(1).optional(),
  classificationVersion: z.string().optional(),
});
export type JobClassification = z.infer<typeof jobClassificationSchema>;
