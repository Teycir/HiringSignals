import { z } from "zod";

/** P0 ATS providers (spec 4.1, 5.3). Extend the same way when a new
 * official, documented public API adapter is added. */
export const ATS_PROVIDERS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "personio",
  "teamtailor",
  "jazzhr",
  "breezy",
  "bamboohr",
] as const;

export const atsProviderSchema = z.enum(ATS_PROVIDERS);
export type AtsProvider = z.infer<typeof atsProviderSchema>;
