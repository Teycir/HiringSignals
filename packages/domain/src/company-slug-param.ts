import { z } from "zod";

/**
 * Path-param schema for GET /api/v1/companies/:slug and
 * .../:slug/timeline (spec §16.3 "all API input is schema-validated").
 * `companies.slug` is a seeded, human-readable identifier (e.g.
 * "harbor-fintech"), not a UUID -- see infrastructure/scripts/
 * seed-local-d1.sql -- so this validates shape (lowercase alphanumeric +
 * hyphens, matching every existing slug) rather than a specific format
 * like `.uuid()`. Bounded at 100 chars, well above any real slug, purely
 * to reject pathological input before it reaches getCompanyBySlug.
 *
 * Not a security fix -- getCompanyBySlug already parameterizes its query
 * (`WHERE slug = ?`), so a malformed slug was never an injection risk,
 * only an unvalidated 404-vs-400 gap. One schema shared by both routes
 * that take `:slug` so they can't drift on what counts as valid.
 */
export const companySlugParamSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with hyphen separators"),
});

export type CompanySlugParam = z.infer<typeof companySlugParamSchema>;
