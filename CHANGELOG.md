# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-27

### Added

- **Phase 0 Foundation:** Complete pnpm workspace scaffold with strict TypeScript base config, Prettier, and shared ESLint base
- **Apps/Web:** Next.js 16 + Tailwind scaffold with API client wired to call Worker API only (spec 12.1)
- **Apps/API:** Hono Worker with middleware chain (request-id, security-headers, error-handler), route stubs, cron scheduler, queue consumer, and wrangler.toml with D1/KV/Queues bindings (spec 13.1)
- **Packages/Domain:** Role taxonomy, ATS provider enum, NormalizedJob/Signal/IngestMessage Zod schemas, and API envelope helpers
- **Packages/Adapters:** AtsAdapter interface implementation (spec 5.3)
- **Packages/DB:** D1 schema migration (0001_initial_schema.sql) with full schema from spec 8.2, parameterized D1 client wrapper (spec 14.1), and repository implementations for signals, companies, and facets
- **Database Repositories:** 
  - Cursor-paginated signal list (score_desc/newest/company_asc) with keyset pagination
  - Signal detail with signal_evidence rows (spec 9.3)
  - Company autocomplete search, get-by-slug, and recent-signals-for-company (spec 9.2, 10.5)
  - Role/source/location aggregate counts via D1 batch() round trip
- **API Routes:** GET /api/v1/signals, /signals/:id, /companies, /companies/:slug, /facets now query D1 through packages/db instead of returning stub data
- **Facets Caching:** 60s KV cache for facets route (spec 15)
- **Greenhouse ATS Adapter:** Full implementation with location inference, fixture-driven tests, and comprehensive error handling
- **Location Inference:** Automatic detection of remote/hybrid/onsite from raw location strings with hybrid precedence
- **Signal API Hardening:** 
  - Roles filter validated against RoleCategory schema
  - Free-text search across headline/summary/company name
  - Country code coerced to uppercase (ISO 3166-1 alpha-2)
  - Source/signalType validated against domain enums
  - observedSince requires real ISO-8601 datetime
  - Opaque cursor using base64-encoded JSON to handle company names with delimiters
  - Per-row degradation for corrupt database rows instead of full page failures
- **Database Indexes:** Migration 0002 adding indexes on signal_evidence(signal_id/job_id) and jobs(status, location_mode, country_code)
- **Raw Payload Archival:** KV-based archival system replacing R2, with 30-day TTL matching retention rules
- **Documentation Files:** AGENTS.md (AI agent roadmap), CHANGELOG.md, llm.txt (machine-readable project summary), project-metadata.json (structured metadata)
- **README Enhancements:** Comprehensive badges section, use cases table, table of contents, license section, donation section, and related projects section
- **AI Agent Discovery:** Machine-readable project metadata for AI agent discovery and integration

### Changed

- **Architecture:** Removed R2 from architecture entirely; raw payloads now archived in KV with TTL-based cleanup
- **Storage Responsibilities:** Export artifacts folded into KV/TTL pattern instead of separate R2 storage
- **Tech Stack:** Updated to reflect real provisioned D1 database_id and KV namespace_id instead of placeholders
- **README Structure:** Reorganized to follow professional project documentation standards with enhanced navigation
- **Spec Documentation:** Updated hiring-signals-spec.md to remove R2 references across architecture diagram, tech-stack table, storage responsibilities, schema, retention, failure-handling, secrets, and environment sections
- **Tooling:** Migrated to ESLint 10 flat config across entire workspace with package-specific configs
- **Dependency Management:** Normalized package.json dependency blocks and updated TypeScript tooling

### Fixed

- **SQL Injection:** Escaped LIKE wildcards in company search to prevent % and _ in queries from being interpreted as SQL wildcards
- **Cursor Pagination:** Fixed cursor encoding/decoding to respect sort mode; switching sort between pages now throws InvalidCursorError instead of silently corrupting pagination
- **Signal Filters:** Fixed locationMode, country, and source filters which were previously accepted but not applied (silent no-ops)
- **Type Safety:** Added proper enum validation for role_category, signal_type, and status with CorruptSignalRowError for corrupt database rows

### Security

- **Input Validation:** All API inputs now validated against domain schemas with proper error responses
- **SQL Safety:** All database queries use parameterized statements via D1Client wrapper; no raw string concatenation
- **Error Handling:** Framework-agnostic error design allows packages/db to throw typed errors without Hono dependencies

### Testing

- **Adapter Tests:** Fixture-driven tests for Greenhouse normalization, malformed payloads, and location inference edge cases
- **Location Tests:** Comprehensive tests for location mode inference including edge cases (hybrid precedence, word boundaries, unknown values)

### Documentation

- **docs(readme):** Comprehensive README enhancements following industry best practices for project documentation
- **docs(code-quality):** Added comprehensive code quality report analyzing TypeScript best practices adherence, type safety, error handling, and architecture patterns
- **docs(code-quality):** Documented alignment with programming skill standards including parse-don't-validate, strict typing, and modern tooling recommendations
- **docs(agents):** AGENTS.md provides living roadmap for AI agents working in this repo with implementation status tracking
- **docs(spec):** Updated hiring-signals-spec.md to reflect architectural changes (R2 removal) and current implementation status
- **docs(discovery):** Added llm.txt and project-metadata.json for AI agent discovery and integration

---

[0.1.0]: https://github.com/Teycir/HiringSignals/releases/tag/v0.1.0
