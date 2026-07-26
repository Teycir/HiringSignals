// Repository functions, one module per aggregate (spec 8.2). Every query
// goes through the D1Client wrapper (d1-client.ts), which enforces
// parameterized statements only -- no raw string concatenation into SQL
// (spec 14.1). Sources/jobs repos land alongside the ingestion consumer
// in a later phase; signals/companies/facets are wired first since the
// read routes need them now.

export * from "./d1-client";
export * from "./signals-repo";
export * from "./companies-repo";
export * from "./facets-repo";
