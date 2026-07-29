// Repository functions, one module per aggregate (spec 8.2). Every query
// goes through the D1Client wrapper (d1-client.ts), which enforces
// parameterized statements only -- no raw string concatenation into SQL
// (spec 14.1). sources-repo/jobs-repo are the write-path repos (ROADMAP.md
// Milestone A) that back the scheduler, queue consumer, and admin routes.

export * from "./d1-client";
export * from "./signals-repo";
export * from "./companies-repo";
export * from "./facets-repo";
export * from "./sources-repo";
export * from "./jobs-repo";
export * from "./signals-write-repo";
export * from "./company-role-stats-repo";
