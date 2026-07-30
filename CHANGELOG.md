# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- **Milestone F — Dashboard UI, animation/inspiration source decided:** `ROADMAP.md`'s Milestone F section (previously a one-line stub) now records a concrete decision with the user: reuse `ArxivExplorer` (same author/account) for the dashboard shell's animation mechanics and interaction timing — `ScrollProgress`, `Card`'s hover/lift/corner-accent pattern (mouse-tracking glow explicitly dropped as incompatible with spec §11's Minimal Brutalist system), `AnimatedTagline`'s character-cascade entrance (with a `prefers-reduced-motion` guard added, since ArxivExplorer's own version lacks one), and optionally `DecryptedText`'s scramble-reveal. `ParticleBackground` (Three.js ambient field) and `background-beams` (SVG beams) are explicitly rejected as pure decoration conflicting with spec §11.1. Visual styling is never ported, only behavior — same rule Milestone I.4 already established for the search UI. `apps/web` doesn't have `framer-motion` installed yet; flagged as a dependency to add when F actually starts. Milestone F itself is still not detailed task-by-task beyond this scoping decision.
- **Milestone I — Semantic search (Workers AI + Vectorize):** Scoped in `ROADMAP.md`. I.1 (index + bindings) and I.2 (embedding write path — jobs embedded and upserted into Vectorize at ingest time, best-effort/non-blocking) done — see Added below. I.3 (query-side hybrid search) is partially done: the semantic-search service and keyword/semantic merge logic are both implemented, but neither is called from the live `GET /api/v1/signals` route yet, and the embedding backfill script for pre-existing jobs hasn't run. I.4 (search UI) and I.5 (classification assist) not started. Ships in two phases: (1) free-text search feature, (2) classification assist — the latter strictly additive to the existing deterministic classification rules (spec §6.2), never a dependency for them. Spec addendum at `hiring-signals-spec.md` §9.4 ("Semantic search").

### Fixed

- **2026-07-30 — Docs/reality sync pass:** `README.md`, `llm.txt`, and `project-metadata.json` had all drifted well behind `ROADMAP.md`'s actual status — none mentioned Milestones H (real V/A/B scoring, all four company-level signal types, daily reconciliation) or I.1/I.2 (Vectorize/Workers AI), and `llm.txt`/`project-metadata.json` were still frozen at a Phase 0/1 "in progress" status that listed Cloudflare Access auth as pending work, contradicting the project's actual permanent no-auth decision (spec §3/§13.5/§14.1). All three brought in line with what's actually on disk and passing (163 tests, `pnpm -r typecheck`/`lint` clean) rather than trusted from prior summaries, per `AGENTS.md`'s own verification policy. Also fixed a real, currently-failing bug found during this pass: `apps/api/test/jobs/ingest-consumer.test.ts`'s `makeFakeEnv()` had a duplicate `ADMIN_SECRET` key in one object literal, breaking `pnpm --filter @hiring-signals/api typecheck` (`TS1117`) — removed the duplicate, re-verified typecheck/lint/test all clean.
- **Spec/reality drift in `hiring-signals-spec.md` §10.1's route table:** removed a stale `/admin` row ("Protected ingestion/source management") left over from before the no-auth decision (§13.5/§14.1) and Milestone D's removal of `/api/v1/admin/*`. Replaced with a note pointing to §13.5/§14.1: source management is a local CLI script against D1, never a route in the deployed app. §13.5/§14.1 themselves were already correct — only §10.1's table had drifted.

### Added

- **Milestone I.2 — Embedding write path:** Jobs are embedded (`buildJobEmbeddingText`) and upserted into the `hiring-signals-jobs` Vectorize index at ingest time (`embedAndUpsertJob` in `ingest-consumer.ts`), gated on new-or-content-changed jobs, wrapped in try/catch so an embedding failure never fails or retries the enclosing ingest message.
- **Milestone I.1 — Vectorize index + Workers AI binding:** Provisioned `hiring-signals-jobs` Vectorize index (768-dim, cosine, matching `@cf/baai/bge-base-en-v1.5`'s output) with metadata indexes on `companyId`/`roleCategory`/`locationMode`/`status`/`postedAt` (all string), created before any vectors exist so metadata filtering applies retroactively to every future insert. `[ai]`/`[[vectorize]]` bindings and `EMBEDDING_MODEL` var added to `apps/api/wrangler.toml`; `Bindings` interface updated to match. `wrangler deploy --dry-run` confirms all bindings resolve.
- **Milestone H — Signal-quality logic pass:** Real Volume/Acceleration/Breadth scoring (`score_version` v2, `packages/domain/src/signal-score.ts`), backed by a new `getCompanyRoleActivityStats` repo query (`packages/db/src/company-role-stats-repo.ts`). All four company-level signal types (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand`) now actually get created, not just typed. A description-channel classification-noise fix so an incidental phrase in a job description can no longer override a clean title+department match. A new daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`, `0 6 * * *` cron) recomputes stale active signals' scores without touching `last_detected_at`.
- **`/api/v1/admin/*` (spec §13.5a):** Re-added after the earlier no-auth removal, but narrowly scoped: three idempotent, secret-bearer-token-gated pipeline triggers (source-run, scheduler-flush, reconcile), never a login a user sees and never called from `apps/web`. Source add/edit is still local-ops-script-only.
- **Milestone E — Lever ATS adapter:** Full implementation following same pattern as Greenhouse (location inference, fixture-driven tests, malformed payload handling). Ingestion pipeline now supports both Greenhouse and Lever providers.
- **Milestone D — Source management ops scripts (spec §13.5):** `infrastructure/scripts/add-source.mjs`, `update-source.mjs`, `source-health.mjs` (plus shared `lib/d1-exec.mjs` helper) — plain Node, shell out to `wrangler d1 execute --json` since a live `D1Database` binding only exists inside a Worker, not a plain CLI process. No HTTP surface; matches the no-auth decision below. Manual ingestion trigger is `update-source.mjs --run-now` (clears `next_poll_at` so the real scheduler picks it up) rather than pushing directly onto the queue, since Cloudflare Queues has no CLI send verb.
- **Milestone D — Write pipeline:** `apps/api/src/jobs/scheduler.ts` (cron finds due sources via `getDueSources`, enqueues one `IngestMessage` per source with deterministic per-source jitter, never fetches directly — spec §5.1/§5.2) and `apps/api/src/jobs/ingest-consumer.ts` (full fetch → validate → normalize → upsert → observe → lifecycle → classify → score → signal pipeline, idempotent per `(sourceId, runId)`, every §13.4 failure branch — 429, transient 5xx, 4xx config error, schema mismatch, retry exhaustion — handled as its own branch rather than a generic catch-all). Complete running system, 94 tests passing workspace-wide.
- **Company creation:** `createCompany` write-repo function and `add-company.mjs` ops script with slug uniqueness validation, duplicate detection, and proper error handling.

### Changed

- **Test organization:** All `*.test.ts` files moved from `src/` into sibling `test/` directories across all packages (apps/api, packages/adapters, packages/db, packages/domain). Import paths updated to relative `../src/*` references. Each package's tsconfig includes `test/**/*.ts` for typecheck coverage.
- **Error handling centralization:** `isUniqueConstraintError` helper moved from internal package location to `lib/d1/unique-constraint.ts` (same home as `lib/d1/like-pattern.ts`). All three call sites (sources-repo.ts, companies-repo.ts, ingest-consumer.ts) now import from single source. Deleted empty `packages/db/src/internal/` module.

### Removed

- **No-auth decision (project-wide):** The app has no login and is public/free for anyone, permanently — not a temporary demo posture. Removed `/api/v1/admin/*` HTTP surface entirely (`apps/api/src/routes/admin.ts` deleted, unmounted from `apps/api/src/index.ts`); source management (add/edit source, manual ingestion trigger, health check) is now a local ops script against D1 (`infrastructure/scripts/`, spec §13.5), never a Worker route. Removed `protectedWriteTier` from `apps/api/src/middleware/anti-abuse.ts` (no remaining caller) and deleted `lib/http/turnstile.ts` (its only consumer). Removed `TURNSTILE_SECRET_KEY` from `apps/api/src/bindings.ts` and narrowed `Variables.abuseVerdict` to `"ok" | "rate_limited"` (the CAPTCHA-related states are no longer reachable). `hiring-signals-spec.md`, `ROADMAP.md`, `AGENTS.md`, and `README.md` updated throughout.

### Fixed

- **Signal freshness scoring:** `daysSinceObservation` was hardcoded to 0 at signal creation, making the score's R (freshness) component always e^0=1. Jobs scraped 120 days after posting scored identically to jobs posted today, flooding the top of the signal feed with stale listings. Now anchors on `job.postedAt` when provided by source, falling back to `existing.first_seen_at` (earliest observation) when adapter omits postedAt, and finally `observedAt` as last resort. Feeds real elapsed days into `computeNewJobScore`.
- **Active signal deduplication:** `findActiveSignal` previously matched any `status='active'` signal for a (company, role, type) triple regardless of age. Hiring bursts resuming after multi-month lulls were silently folded into old dormant rows instead of creating fresh signals. Added `ACTIVE_SIGNAL_LOOKBACK_DAYS=28` and bound query on `last_detected_at` so stale-but-still-'active' rows (pending expiration cron sweep) no longer count as dedup matches.
- **Ingest consumer retry logic:** Provider validation errors and schema mismatches (programmer/config errors) now skip retry and set correct `source_run.status` and `error_code`. Only network failures (429, 5xx) trigger exponential backoff retry. Prevents infinite retry loops on permanent failures.
- **Classification threshold bug:** `classifyJob`'s auto-classify threshold for multi-location signals was unreachable due to logic error. Fixed condition evaluation.
- **`job_observations` idempotency gap (ROADMAP.md Milestone A):** Migration 0001 never put a UNIQUE constraint on `(job_id, source_run_id)`, so a retried queue message could insert a duplicate observation row, silently corrupting missing-run-count and lifecycle math (spec §13.3's idempotency requirement). Added `0004_job_observations_idempotency.sql` (`CREATE UNIQUE INDEX idx_job_observations_idempotency`, SQLite has no `ALTER TABLE ADD CONSTRAINT`), applied and verified against local D1 (constraint fires on duplicate insert).
- **Circuit breaker wiring:** `lib/http/circuit-breaker.ts` now actually wired — every D1 call (`first`/`all`/`run`/`batch` in `lib/d1/client.ts`) routed through it on the `"db"` resource. Zero call-site changes needed in routes or repos.
- **Local typecheck:** Removed stray, gitignored `packages/db/src/__sqlite_probe.ts` scratch file that broke `pnpm --filter @hiring-signals/db typecheck` locally.

### Testing

- **Test safety:** DB/CACHE test bindings in `ingest-consumer.test.ts` and `scheduler.test.ts` replaced with throwing Proxy. Instead of unsafe empty-object casts (silent no-ops when mocks in place), now throws descriptive error identifying accessed property and expected mock if binding accessed without proper mock setup.

### Documentation

- **lib/README.md:** module table now lists `http/rate-limit.ts`, `http/turnstile.ts` (later removed, see "Removed" above), `http/circuit-breaker.ts`, and `observability/audit-abuse.ts`, which existed and were in use but missing from the table.

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
