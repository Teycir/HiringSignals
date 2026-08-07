// Repository functions, one module per aggregate (spec 8.2). Every query
// goes through the D1Client wrapper (d1-client.ts), which enforces
// parameterized statements only -- no raw string concatenation into SQL
// (spec 14.1). sources-repo/jobs-repo are the write-path repos (ROADMAP.md
// Milestone A) that back the scheduler, queue consumer, and admin routes.

export * from "./d1-client";
// Type-only barrel with no D1Client dependency -- consumers that only need
// SignalListItem/SignalDetail/CompanySummary/Facets and have no D1
// binding of their own should import from "@hiring-signals/db/src/types"
// directly instead of this root barrel, to avoid tsc resolving
// d1-client.ts's D1Database-typed internals. See types.ts's header
// comment.
export * from "./types";
export * from "./signals-repo";
export * from "./companies-repo";
export * from "./facets-repo";
export * from "./sources-repo";
export * from "./jobs-repo";
export * from "./signals-write-repo";
export * from "./company-role-stats-repo";
