// Repository functions live here, one file per aggregate (companies, sources,
// jobs, signals), each taking a D1Database binding and returning typed rows
// validated against packages/domain schemas (spec 8.2).
//
// Deliberately empty in Phase 0: no D1 migrations or fixtures exist yet
// (see infrastructure/d1/migrations). Phase 1 adds:
//   - migration files under infrastructure/d1/migrations
//   - a thin D1 client wrapper enforcing parameterized queries only (spec 14.1)
//   - repository modules: companies.ts, sources.ts, jobs.ts, signals.ts

export {};
