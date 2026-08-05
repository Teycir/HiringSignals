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
  /**
   * Structured location fields, alongside locationRaw/locationMode above.
   * Optional because not every provider's API exposes structured
   * geography -- some (Ashby, Greenhouse, Lever, Personio) only ever
   * supply a free-text location string, so their adapters' normalize()
   * leave these undefined; others (Breezy, Recruitee, SmartRecruiters,
   * Workable) already receive real structured fields in their raw API
   * responses and map them here. Feeds getCompanyRoleActivityStats's
   * distinctLocationCount (packages/db/src/company-role-stats-repo.ts),
   * which is what multi_location's trigger (H.4) actually checks --
   * before these fields existed, that count silently collapsed to 0 for
   * every job (country_code/region_code/city were always NULL, and
   * SQLite's `||` returns NULL if any operand is NULL, so the composite
   * DISTINCT key was NULL for every row and COUNT(DISTINCT ...) ignores
   * NULLs entirely -- confirmed against the real D1 instance directly,
   * ROADMAP.md's multi_location investigation entry).
   */
  countryCode: z.string().optional(),
  regionCode: z.string().optional(),
  city: z.string().optional(),
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
