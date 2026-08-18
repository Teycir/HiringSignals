export * from "./adapter-contract";
export * from "./location";
export * from "./greenhouse";
export * from "./lever";
export * from "./ashby";
export * from "./smartrecruiters";
export * from "./workable";
export * from "./recruitee";
export * from "./personio";
export * from "./registry";
// smartrecruiters.ts was audited 2026-08-18 for possible removal but
// kept -- its API is live, the original failure was a fixable adapter
// bug, not a dead provider.

// A future new provider adds one file here, each implementing AtsAdapter
// with a provider-specific Zod schema for the raw payload (spec 5.3) plus
// fixture tests (spec 17.1) -- and a corresponding entry in registry.ts's
// ADAPTERS map so the ingest consumer picks it up automatically.
