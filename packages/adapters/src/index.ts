export * from "./adapter-contract";
export * from "./location";
export * from "./greenhouse";

// Phase 1 adds one file per remaining provider here (lever.ts, ashby.ts, ...),
// each implementing AtsAdapter with a provider-specific Zod schema for the
// raw payload (spec 5.3) plus fixture tests (spec 17.1).
