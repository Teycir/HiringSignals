import { z } from "zod";

/** P0 ATS providers (spec 4.1, 5.3). Extend the same way when a new
 * official, documented public API adapter is added.
 *
 * `smartrecruiters` was audited 2026-08-18 after appearing to have
 * only 1 live source -- its API was confirmed live and returning real
 * postings; the adapter's `consecutive_failures` was a real, fixable
 * bug (SmartRecruiters stopped including `actions.details`/
 * `actions.apply` URLs in the list response; canonicalUrl is now
 * synthesized from `posting.id` + boardToken instead), not a dead
 * provider. Kept. */
export const ATS_PROVIDERS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "personio",
] as const;

export const atsProviderSchema = z.enum(ATS_PROVIDERS);
export type AtsProvider = z.infer<typeof atsProviderSchema>;
