export * from "./adapter-contract";
export * from "./location";
export * from "./greenhouse";
export * from "./lever";
export * from "./ashby";
export * from "./smartrecruiters";
export * from "./workable";
export * from "./registry";

// Milestone E (ROADMAP.md) adds one file per remaining provider here
// (ashby.ts, smartrecruiters.ts, ...), each implementing AtsAdapter with a
// provider-specific Zod schema for the raw payload (spec 5.3) plus
// fixture tests (spec 17.1) -- and a corresponding entry in registry.ts's
// ADAPTERS map so the ingest consumer picks it up automatically.
