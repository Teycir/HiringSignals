import type { RoleCategory } from "./role-taxonomy";

/**
 * Phrase and abbreviation rules for deterministic title classification
 * (spec 6.2 steps 2-4). Rules are data, not an if/else chain, so the
 * "labeled fixture set" testing requirement (spec 6.2 step 7, 17.1)
 * stays tractable -- add a row here, add a fixture case, done.
 *
 * All patterns are matched against an already-normalized title (see
 * title-normalize.ts): lowercase, NFKC, punctuation stripped, whitespace
 * collapsed. Write patterns accordingly (no punctuation, no case).
 */

export interface PhraseRule {
  /** Exact phrase to match as a whole-word sequence, e.g. "site reliability engineer". */
  phrase: string;
  category: RoleCategory;
}

export interface AbbreviationRule {
  /** Standalone abbreviation token, e.g. "sre", "soc", "iam", "etl". */
  abbreviation: string;
  category: RoleCategory;
}

export interface NegativeTermRule {
  /** Phrase that must NOT be present for `category` to be accepted via `phrase`/`abbreviation`. */
  term: string;
  category: RoleCategory;
}

// High-precision phrase rules (spec 6.2 step 2). Ordered by specificity
// where overlap is possible -- longer/more-specific phrases first, so a
// title matching multiple rows resolves to the most precise one.
export const PHRASE_RULES: readonly PhraseRule[] = [
  // Software Engineering
  { phrase: "software engineer", category: "software_engineering" },
  { phrase: "software developer", category: "software_engineering" },
  { phrase: "backend engineer", category: "software_engineering" },
  { phrase: "frontend engineer", category: "software_engineering" },
  { phrase: "full stack engineer", category: "software_engineering" },
  { phrase: "full stack developer", category: "software_engineering" },
  { phrase: "mobile engineer", category: "software_engineering" },
  { phrase: "ios engineer", category: "software_engineering" },
  { phrase: "android engineer", category: "software_engineering" },

  // Data Engineering / Analytics
  { phrase: "data engineer", category: "data_engineering_analytics" },
  { phrase: "data analyst", category: "data_engineering_analytics" },
  { phrase: "analytics engineer", category: "data_engineering_analytics" },
  { phrase: "business intelligence analyst", category: "data_engineering_analytics" },

  // Cloud / Platform / DevOps / SRE
  { phrase: "site reliability engineer", category: "cloud_platform_devops_sre" },
  { phrase: "platform engineer", category: "cloud_platform_devops_sre" },
  { phrase: "devops engineer", category: "cloud_platform_devops_sre" },
  { phrase: "cloud engineer", category: "cloud_platform_devops_sre" },
  { phrase: "infrastructure engineer", category: "cloud_platform_devops_sre" },

  // Cybersecurity
  { phrase: "security engineer", category: "cybersecurity" },
  { phrase: "security analyst", category: "cybersecurity" },
  { phrase: "penetration tester", category: "cybersecurity" },
  { phrase: "security operations center analyst", category: "cybersecurity" },
  { phrase: "application security engineer", category: "cybersecurity" },

  // IT Support / Help Desk
  { phrase: "help desk technician", category: "it_support_help_desk" },
  { phrase: "it support specialist", category: "it_support_help_desk" },
  { phrase: "desktop support technician", category: "it_support_help_desk" },
  { phrase: "service desk analyst", category: "it_support_help_desk" },

  // Systems / Network Administration
  { phrase: "systems administrator", category: "systems_network_administration" },
  { phrase: "network administrator", category: "systems_network_administration" },
  { phrase: "network engineer", category: "systems_network_administration" },
  { phrase: "systems engineer", category: "systems_network_administration" },

  // QA / Test Automation
  { phrase: "qa engineer", category: "qa_test_automation" },
  { phrase: "test automation engineer", category: "qa_test_automation" },
  { phrase: "quality assurance engineer", category: "qa_test_automation" },
  { phrase: "software test engineer", category: "qa_test_automation" },

  // Product / Technical Program Management
  { phrase: "technical program manager", category: "product_technical_program_management" },
  { phrase: "product manager", category: "product_technical_program_management" },
  { phrase: "technical product manager", category: "product_technical_program_management" },

  // ERP / Business Systems
  { phrase: "erp analyst", category: "erp_business_systems" },
  { phrase: "business systems analyst", category: "erp_business_systems" },
  { phrase: "sap consultant", category: "erp_business_systems" },
  { phrase: "salesforce administrator", category: "erp_business_systems" },

  // AI / Machine Learning
  { phrase: "machine learning engineer", category: "ai_machine_learning" },
  { phrase: "ai engineer", category: "ai_machine_learning" },
  { phrase: "ml engineer", category: "ai_machine_learning" },
  { phrase: "research scientist", category: "ai_machine_learning" },
] as const;

// Approved abbreviations (spec 6.2 step 3). Matched as standalone word
// tokens only (see classification.ts) so e.g. "sre" doesn't match inside
// a longer unrelated token.
export const ABBREVIATION_RULES: readonly AbbreviationRule[] = [
  { abbreviation: "sre", category: "cloud_platform_devops_sre" },
  { abbreviation: "devops", category: "cloud_platform_devops_sre" },
  { abbreviation: "soc", category: "cybersecurity" },
  { abbreviation: "iam", category: "cybersecurity" },
  { abbreviation: "grc", category: "cybersecurity" },
  { abbreviation: "etl", category: "data_engineering_analytics" },
  { abbreviation: "bi", category: "data_engineering_analytics" },
  { abbreviation: "qa", category: "qa_test_automation" },
  { abbreviation: "sdet", category: "qa_test_automation" },
  { abbreviation: "tpm", category: "product_technical_program_management" },
  { abbreviation: "erp", category: "erp_business_systems" },
  { abbreviation: "ml", category: "ai_machine_learning" },
  { abbreviation: "ai", category: "ai_machine_learning" },
] as const;

// Negative-term guard (spec 6.2 step 4): a phrase/abbreviation match for
// `category` must be rejected if `term` also appears in the title. The
// canonical example: "security guard" must not map to cybersecurity even
// though "security" alone might otherwise contribute department/desc
// signal for that category.
export const NEGATIVE_TERM_RULES: readonly NegativeTermRule[] = [
  { term: "security guard", category: "cybersecurity" },
  { term: "guard", category: "cybersecurity" },
  { term: "physical security", category: "cybersecurity" },
  { term: "product marketing manager", category: "product_technical_program_management" },
  { term: "data entry", category: "data_engineering_analytics" },
] as const;
