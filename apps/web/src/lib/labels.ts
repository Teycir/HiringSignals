// Human-readable display labels for the app's machine-facing enums
// (@hiring-signals/domain's snake_case/lowercase values). Extracted from
// role-filter.tsx (originally ROLE_LABELS) once signal-card.tsx became
// the second consumer that role-filter.tsx's own comment anticipated --
// see git history on role-filter.tsx for the original inline version.
// Every filter component (role/work-mode/source/signal-type-filter) and
// signal-card.tsx should import from here rather than re-declaring their
// own copy, so a label only ever needs updating in one place.
import type {
  AtsProvider,
  LocationMode,
  RoleCategory,
  SignalType,
} from "@hiring-signals/domain";

/** Spec 6.1's canonical P0 role taxonomy. */
export const ROLE_LABELS: Record<RoleCategory, string> = {
  software_engineering: "Software Engineering",
  data_engineering_analytics: "Data Engineering & Analytics",
  cloud_platform_devops_sre: "Cloud / Platform / DevOps / SRE",
  cybersecurity: "Cybersecurity",
  it_support_help_desk: "IT Support / Help Desk",
  systems_network_administration: "Systems & Network Administration",
  qa_test_automation: "QA / Test Automation",
  product_technical_program_management: "Product / Technical Program Mgmt",
  erp_business_systems: "ERP / Business Systems",
  ai_machine_learning: "AI / Machine Learning",
};

export const LOCATION_MODE_LABELS: Record<LocationMode, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "Onsite",
  unknown: "Unknown",
};

/** P0 ATS providers (@hiring-signals/domain's ATS_PROVIDERS). */
export const PROVIDER_LABELS: Record<AtsProvider, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workable: "Workable",
  recruitee: "Recruitee",
  personio: "Personio",
  teamtailor: "Teamtailor",
  jazzhr: "JazzHR",
  breezy: "Breezy",
  bamboohr: "BambooHR",
};

/** Spec 7.1's signal types. */
export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  new_job: "New job",
  reopened_job: "Reopened job",
  hiring_burst: "Hiring burst",
  role_acceleration: "Role acceleration",
  multi_location: "Multi-location",
  persistent_demand: "Persistent demand",
};
