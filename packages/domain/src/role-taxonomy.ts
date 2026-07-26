import { z } from "zod";

/** Canonical P0 role categories (spec 6.1). */
export const ROLE_CATEGORIES = [
  "software_engineering",
  "data_engineering_analytics",
  "cloud_platform_devops_sre",
  "cybersecurity",
  "it_support_help_desk",
  "systems_network_administration",
  "qa_test_automation",
  "product_technical_program_management",
  "erp_business_systems",
  "ai_machine_learning",
] as const;

export const roleCategorySchema = z.enum(ROLE_CATEGORIES);
export type RoleCategory = z.infer<typeof roleCategorySchema>;
