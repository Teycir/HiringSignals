# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Milestone Q — Hiring velocity score per company (`packages/domain/src/hiring-velocity.ts`):** Investor-grade company-level score answering "how aggressively is this company building its team right now" — distinct from the existing per-signal score, which only ranks individual role-level postings. `computeHiringVelocity` (Q.1) is a pure function: `V = clamp(0.40*acceleration + 0.25*breadth + 0.20*volume_norm + 0.15*persistence, 0, 1) * 100`, reusing `computeAcceleration`/`computeBreadth` from `signal-score.ts` fed company-wide (all-role) counts instead of per-role ones. Persisted via three new nullable `companies` columns (`hiring_velocity_score`, `velocity_score_version`, `velocity_computed_at`; migration `0008_company_velocity_score.sql`) — null means not-yet-computed, never fabricated as 0. Q.2 wires a `handleVelocityRecompute` pass into the daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`), running once per company that had ≥1 signal genuinely reconciled that run via a new `getCompanyActivityStats` (`packages/db/src/company-role-stats-repo.ts`) and `updateCompanyVelocityScore` (`packages/db/src/companies-repo.ts`). Q.3 surfaces `hiringVelocityScore` on `GET /api/v1/trends/hiring` (new `sort=velocity_desc`, null scores sort last) and `GET /api/v1/companies`/`:slug`, plus a shared `HIRING_VELOCITY_DISCLAIMER` constant ("Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.", spec §11.3) in each response's `meta`. `hs trends hiring` picks up `velocity_desc` automatically via `Partial<TrendsQuery>`; JSON-only output, no `--format table` per F.1.1's CLI-wide decision. 13 new tests (12 hand-computed unit tests in `hiring-velocity.test.ts`; 1 live-D1 `velocity_desc` sort test in `trends-repo.test.ts` covering high/low/uncomputed companies) plus `api-client.test.ts` extended to round-trip the disclaimer field through `fetchHiringTrends`/`fetchCompanies`/`fetchCompanyDetail`. `pnpm -r typecheck` clean across all 6 workspace packages.
- **Milestone P — Hiring trend API: cross-company analytics (`GET /api/v1/trends/hiring`):** Market-intelligence layer beyond O's single-company timeline — "which fintechs started hiring ML in the last 60d," ranked companies rather than one company's history. `getHiringTrends` (P.2, `packages/db/src/trends-repo.ts`) aggregates job/signal activity per company via conditional-SUM queries against `idx_jobs_trends` (migration `0007_trends_role_first_seen_index.sql`), with `acceleration_desc`/`volume_desc`/`newest_signal`/`velocity_desc` sort options and a top-5-per-company location breakdown computed in code. Route (`apps/api/src/routes/trends.ts`) has a 5-minute KV cache keyed on every param that affects the result, with `resolveTrendsSince`/`buildTrendsCacheKey` extracted as pure, directly-unit-tested functions rather than folded into the handler. `hs trends hiring` (P.3, `apps/cli`) is the CLI surface, JSON-only per F.1.1. 6 live-D1 tests in `trends-repo.test.ts` (acceleration/volume/industry-filter/topLocations/zero-new-jobs-exclusion — later joined by Q.3's `velocity_desc` test above) plus route-layer pure-function tests in `apps/api/test/routes/trends.test.ts`. `pnpm -r typecheck` clean.
- **Milestone O — Company hiring timeline API (`GET /api/v1/companies/:slug/timeline`) + `hs companies timeline` CLI:** Time-bucketed hiring activity per company (new/closed/active jobs per window, role/location breakdowns, signal types per bucket) queryable by role category and date range with caller-selectable bucket widths (7/14/30 days, 90-day window cap). `getCompanyHiringTimeline` in `companies-repo.ts`; `companyTimelineQuerySchema` and `resolveTimelineWindow` in `packages/domain/src/company-timeline-query.ts` (pure, unit-tested). CLI side: `hs companies timeline <slug> [--since --until --roles --bucket-days]`.
- **Milestone N — Saved filter profiles (`apps/cli`):** `hs signals list --save` persists the given filter flags (role/company/q/locationMode/country/source/signalType/minScore/observedSince — not sort/cursor/limit) to a local config file (`~/.hiring-signals/config.json`, or `$XDG_CONFIG_HOME/hiring-signals/config.json` when set). Running `hs signals list` with no filter flags and a saved profile present applies it automatically, printing a one-line `Using saved filters: ...` note to stderr so the behavior stays visible rather than silent (stdout stays pure JSON). `hs signals list --clear-saved` removes it. Stores raw pre-parse flag strings rather than `signalsQuerySchema`'s parsed/defaulted output, so saved profiles never silently pick up `sort`/`limit`/`minScore` defaults for fields the user never touched; invalid or corrupt saved JSON is silently discarded on load via `signalsQuerySchema.safeParse`, no versioning, no re-save prompt. New `apps/cli/src/config-store.ts`. 22 new tests (`config-store.test.ts`, `signals-list-saved-filters.test.ts`, the latter real `bin/hs.mjs` subprocess spawns); manually verified end-to-end against a live local `wrangler dev` instance.
- **Milestone R — RSS feed (`GET /api/v1/feed.rss`) + `hs feed-url`:** Closes the "notify me later" gap — push-style delivery via any feed reader, no accounts, no new infrastructure. `lib/text/rss.ts` (R.1) is a dependency-free RSS 2.0 serializer (XML-escaped, RFC 822 dates, `<link>` omitted for company-level aggregate signals with no job-linked evidence). `apps/api/src/routes/feed.ts` (R.2) serves it at `GET /api/v1/feed.rss`, capped at `FEED_ROW_CAP = 50` items via a new `listSignalsForFeed` in `packages/db/src/signals-repo.ts`, with `ETag`/`Last-Modified`/`304 Not Modified` support and no KV caching. `hs feed-url` (R.3, `apps/cli`) prints the feed URL for a given filter set, reusing `signalsQuerySchema.omit(...)` and the same query-serialization helper the CLI's own HTTP calls use. 13 new tests (7 serializer, 6 CLI URL-building); manually verified end-to-end including the 304 conditional-request path.
- **Milestone F.1 — CLI (`apps/cli`), primary interface:** New `citty`-based workspace package, the primary interface now that `apps/web` is deleted. JSON-by-default on stdout, single-JSON-object machine-readable errors on stderr, no interactive prompts (admin actions require an explicit `--yes` instead). Thin client over `apps/api`'s existing routes only — no D1 access, no bypassing the API's own validation/rate-limiting/auth. Commands: `hs facets`, `hs signals list/get`, `hs companies list/get/timeline`, `hs sources list`, `hs trends hiring`, `hs feed-url`, `hs export signals [--out <path>]`, `hs admin source run/scheduler flush/reconcile`. `--format table` renderer added later (F.1 follow-up 2026-08-10) for list-style commands; detail commands and genuinely-nested shapes fall back to JSON with a one-line stderr note. `signalsQuerySchema` moved from `apps/api/src/routes/signals.ts` into `packages/domain/src/signals-query.ts` so the route and the CLI validate against the exact same schema. Tests: `test/api-client.test.ts` (14, mocked `fetch`) and `test/cli-process.test.ts` (5, real subprocess spawns asserting exit code and stderr shape). See `apps/cli/README.md` for exact invocations/output per command.
- **Milestone G.5 acceptance-criteria gaps closed (2026-08-10 → 2026-08-11):** `--format table` CLI output renderer for flat-list commands (§16.2); custom-career-site host injection fixes in `breezy.ts` and `personio.ts` adapters (§16.3.2, port-injection bug via `isValidCustomHost()` checking `url.host` instead of `url.hostname`); path-param schema validation for `GET /signals/:signalId` and `GET /companies/:slug`/`:slug/timeline` (§16.3.3 — new shared `signal-id-param.ts` / `company-slug-param.ts` schemas in `packages/domain/src`); API error-rate monitoring via Analytics Engine binding `API_METRICS` + `apps/api/src/middleware/api-metrics.ts` (§16.3.6, 12 tests in `api-metrics.test.ts` for route-shape normalization).
- **Milestone I.1 & I.2 — Semantic search write path (Vectorize index + Workers AI embedding write):** Provisioned `hiring-signals-jobs` Vectorize index (768-dim, cosine, `@cf/baai/bge-base-en-v1.5` matching) with metadata indexes on `companyId`/`roleCategory`/`locationMode`/`status`/`postedAt` (I.1). Jobs embedded (`buildJobEmbeddingText`) and upserted at ingest time, gated on new-or-content-changed jobs, try/catch so an embedding failure never fails the enclosing ingest message (I.2).
- **Milestone H — Signal-quality logic pass:** Real Volume/Acceleration/Breadth scoring (`score_version` v2, `packages/domain/src/signal-score.ts`), backed by a new `getCompanyRoleActivityStats` repo query (`packages/db/src/company-role-stats-repo.ts`). All four company-level signal types (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand`) now actually get created, not just typed. A description-channel classification-noise fix so an incidental phrase in a job description can no longer override a clean title+department match. A new daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`, `0 6 * * *` cron) recomputes stale active signals' scores without touching `last_detected_at`.
- **Milestone E — 8 ATS Adapters (closed):** Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio, Breezy — all via official documented APIs, each with fixture-driven tests covering malformed payloads and location-mode inference.
- **CSV Export Endpoint (`GET /api/v1/export/signals.csv`):** Full export API accepting all signal filter parameters. Returns RFC-4180 compliant CSV stream with a 2,000-row safety limit and `X-Export-Truncated` header. Backed by `exportSignals` in `packages/db/src/signals-export-repo.ts`. Also exposed as `hs export signals`.
- **Bulk Source Onboarding (`import-sources.mjs`):** Ops script for CSV-based batch company and source creation with pre-validation, duplicate skipping, and interactive confirmation.
- **Source management ops scripts (spec §10.5):** `infrastructure/scripts/add-source.mjs`, `update-source.mjs`, `add-company.mjs`, `update-company.mjs`, `source-health.mjs`, `ingestion-metrics.mjs`, `backfill-embeddings.mjs` (plus shared `lib/d1-exec.mjs` helper) — plain Node, shell out to `wrangler d1 execute --json` since a live `D1Database` binding only exists inside a Worker. Manual ingestion trigger is `update-source.mjs --run-now` (clears `next_poll_at`). `update-company.mjs` exposes `industry`/`employee-band`/`remote` tagging for companies.
- **`/api/v1/admin/*` (spec §10.5a):** Three secret-bearer-token-gated pipeline triggers (source-run, scheduler-flush, reconcile); source add/edit remains local-ops-script-only.
- **Milestone D — Write pipeline:** `apps/api/src/jobs/scheduler.ts` (cron finds due sources via `getDueSources`, enqueues one `IngestMessage` per source with deterministic per-source jitter, never fetches directly — spec §5.1/§5.2) and `apps/api/src/jobs/ingest-consumer.ts` (full fetch → validate → normalize → upsert → observe → lifecycle → classify → score → signal pipeline, idempotent per `(sourceId, runId)`, every §10.4 failure branch handled explicitly). Ingest pipeline fixed 2026-08-11 for the Cloudflare 1000-subrequest-per-invocation cap: `upsertJob` + `applyLifecycleTransition` combined into a single `client.batch()` call per job via `prepareJobUpsert`/`buildLifecycleStatement` pure statement builders, cutting per-job D1 calls from 3 to 2.
- **Zero-Mocks Live Cloudflare Test Infrastructure (`packages/test-support`):** Remote transport layer, live D1 database client (`live-d1-client.ts`), and live KV/AI/Vectorize bindings (`live-cf-bindings.ts`) for end-to-end integration testing against real Cloudflare resources without mocks. Used by `packages/db` and `apps/api` suites per AGENTS.md's zero-mocks policy.

### Changed

- **README accuracy pass (2026-08-13):** Corrected stale claims across the Layout table, Tech Stack, Key Features, and Local dev sections: migration count updated from 0001-0004 to 0001-0009 (all 9 landed); `apps/api` description now lists company timeline route, trends route, RSS feed route, and API metrics middleware; CLI commands now include `hs companies timeline`, `hs feed-url`, and `hs trends hiring`; `lib/` description corrected (RSS serializer added to text utilities); ops scripts list now includes `update-company.mjs` and `ingestion-metrics.mjs`; semantic search status corrected from "write path only" to fully live (both write and query paths wired, Milestone I.3 complete); hiring velocity score surfaced in trends/companies descriptions.
- **Test organization:** All `*.test.ts` files moved from `src/` into sibling `test/` directories across all packages (apps/api, packages/adapters, packages/db, packages/domain). Import paths updated to relative `../src/*` references. Each package's tsconfig includes `test/**/*.ts` for typecheck coverage.
- **Error handling centralization:** `isUniqueConstraintError` helper moved from internal package location to `lib/d1/unique-constraint.ts`. All three call sites now import from single source. Deleted empty `packages/db/src/internal/` module.

### Security & Fixed

- **Rate-limit Identifier Hashing (`lib/http/rate-limit.ts`):** Implemented `safeRateLimitIdentifier()` SHA-256 base64url hashing before key construction. Eliminates IPv6 colon separator injection and key boundary confusion that previously allowed counter bleeding across shards (security review 2026-07-30 HIGH 1 finding). Scrubs plaintext IP PII from KV keys.
- **Trusted-First Client IP Resolution (`apps/api/src/middleware/client-ip.ts`):** Security fix enforcing trusted IP extraction (`CF-Connecting-IP` > last hop of `X-Forwarded-For` > `"unknown"`). Prevents client spoofing of `X-Forwarded-For[0]` to bypass rate limits (security review 2026-07-30 HIGH 3 finding).
- **ATS adapter custom-host validation bug (breezy.ts + personio.ts, spec §16.3.2):** Both adapters' `isValidCustomHost()` guard checked `url.host` (port-inclusive) instead of `url.hostname` (port-free), allowing an explicit non-default port (e.g. `169.254.169.254:80`, the cloud metadata IP) to round-trip through unchanged. Fixed both adapters to require `url.port === ""`; added 5 targeted unit tests per adapter including the port-injection test that caught the bug.
- **Route path-param schema validation (spec §16.3.3):** `GET /signals/:signalId`, `GET /companies/:slug`, and `GET /companies/:slug/timeline` previously accepted raw unchecked path params (malformed values → 404 instead of 400). Added two shared `packages/domain` schemas: `signal-id-param.ts` (UUID regex, since signals IDs are always `crypto.randomUUID()`) and `company-slug-param.ts` (lowercase-alphanumeric-hyphen, 100-char bound, validated against every slug in `seed-local-d1.sql`). All three routes now `.parse()` and let the central `errorHandler` return 400/`INVALID_FILTER`; well-formed-but-nonexistent ids still correctly return 404.
- **API error-rate monitoring gap (spec §16.3.6):** Central `errorHandler` previously only did unstructured `console.error` with no queryable aggregate. Added `[[analytics_engine_datasets]]` binding (`API_METRICS`) to `wrangler.toml` and a new `apps/api/src/middleware/api-metrics.ts` middleware that writes one data point per completed request to Analytics Engine (`blobs: [method, routeShape]`, `doubles: [status, durationMs]`). `normalizeRoutePath` collapses UUID/slug segments into `:id`/`:param` before use as an index, keeping cardinality bounded to the route table.
- **`source-health.mjs` stuck-run detection gap (ROADMAP G.3 / 2026-08-11):** `deriveStatus()` only branched on `enabled`/`consecutive_failures`/`last_run_status === 'failed_final'`, so a source run that crashed mid-invocation (the Cloudflare subrequest-cap bug, see `ingest-consumer.ts` batch fix above) and never resolved to a terminal state was invisible — `openai` had 277 such rows showing as "healthy, 0 failures". Added a `running_minutes` correlated scalar subquery on the latest-run lookup, `STALE_RUNNING_MINUTES = 90` threshold, and a new `"stuck"` status branch checked before degraded/failed so low `consecutive_failures` can't mask it.
- **Ingest consumer subrequest-cap fix (2026-08-11):** `processNormalizedJob` issued 3 D1 calls per job (upsert + observation + lifecycle), deterministically exceeding Cloudflare's 1000-service-subrequest-per-invocation free-plan cap on any board ≳340 jobs. Split `upsertJob` → `prepareJobUpsert` + thin wrapper and `applyLifecycleTransition` → `buildLifecycleStatement` + thin wrapper, then `client.batch()` the two statements, cutting per-job D1 calls to 2. The observation call stays unbatched: its idempotency contract depends on catching its own UNIQUE violation in isolation.
- **Ingest consumer retry logic:** Provider validation errors and schema mismatches (programmer/config errors) now skip retry and set correct `source_run.status` and `error_code`. Only network failures (429, 5xx) trigger exponential backoff retry. Prevents infinite retry loops on permanent failures. Retry increment bug also fixed: replaced broken native `message.retry()` with explicit `INGEST_QUEUE.send()` carrying `attempt + 1`, so retry attempts actually increment.
- **Signal freshness scoring:** `daysSinceObservation` was hardcoded to 0 at signal creation, making the score's R (freshness) component always e^0=1. Jobs scraped 120 days after posting scored identically to jobs posted today. Now anchors on `job.postedAt` when provided by source, falling back to `existing.first_seen_at` (earliest observation) when adapter omits postedAt, and finally `observedAt` as last resort.
- **Active signal deduplication:** `findActiveSignal` previously matched any `status='active'` signal for a (company, role, type) triple regardless of age. Hiring bursts resuming after multi-month lulls were silently folded into old dormant rows. Added `ACTIVE_SIGNAL_LOOKBACK_DAYS=28` and bound query on `last_detected_at` so stale-but-still-'active' rows no longer count as dedup matches.
- **Reopened Role Signal Refinement (`packages/domain/src/lifecycle.ts`):** Added a 3-day absence threshold (`daysSinceLastSeen >= 3`) before flagging a reappeared closed job as a `reopened_job` signal. Prevents single-run scrape glitches or transient ATS 4xx errors from triggering false reopened role signals.
- **Signal Detail Status Guard (`packages/db/src/signals-repo.ts`):** Restricted `getSignalDetail` to `s.status = 'active'` to prevent deleted or dormant signals from being returned in detail views.
- **Active Signal Query Optimization (`packages/db/src/signals-write-repo.ts`):** Replaced client-computed ISO dates with SQLite native `datetime('now', '-28 days')` in `findActiveSignal` and `findActiveSignalsBatch`.
- **Security Headers Middleware Response Wrapper (`apps/api/src/middleware/security-headers.ts`):** Fixed wrapper to pass through base middleware `Response`.
- **Classification threshold bug:** `classifyJob`'s auto-classify threshold for multi-location signals was unreachable due to logic error. Fixed condition evaluation.
- **`job_observations` idempotency gap (ROADMAP Milestone A):** Migration 0001 never put a UNIQUE constraint on `(job_id, source_run_id)`, so a retried queue message could insert a duplicate observation row. Added `0004_job_observations_idempotency.sql` (`CREATE UNIQUE INDEX idx_job_observations_idempotency`), applied and verified against local D1.
- **Circuit breaker wiring:** `lib/http/circuit-breaker.ts` now actually wired — every D1 call routed through it on the `"db"` resource.
- **Local typecheck:** Removed stray, gitignored `packages/db/src/__sqlite_probe.ts` scratch file that broke typecheck locally.

### Removed

- **`apps/web` (dashboard) — deleted 2026-08-07:** Removed entirely, not deprioritized or left in place. Decided with the user that `apps/cli` (Milestone F.1, shipped the same day) is the primary interface going forward. Work previously shipped inside `apps/web` (Milestone F dashboard shell including `/signals` FilterRail/SignalCard/SignalDetail routes and synchronized URL search params; Milestone I.4 search UI with free-text hybrid search bar + MoreLikeThisButton + recent-searches localStorage) remains an accurate historical record but has no current code path.
- **No-auth decision (project-wide, reverted partially later for admin triggers only):** Initial decision removed `/api/v1/admin/*` HTTP surface entirely, deleted `admin.ts`, removed `protectedWriteTier` from anti-abuse middleware, deleted `lib/http/turnstile.ts`, and narrowed `Variables.abuseVerdict` to `"ok" | "rate_limited"`. The admin routes were later re-added (narrowly scoped to three pipeline triggers only, secret-bearer-token gated, never a user-facing login); the no-accounts/no-login/public-free posture for the read surface remains permanent.

### Testing

- **Live-D1 test migration (Milestone J):** All 7 test files that previously used in-memory/synthetic D1/AI/Vectorize/KV stand-ins migrated to use real live Cloudflare resources via `packages/test-support` per AGENTS.md's zero-mocks policy. Two documented permanent exceptions: ATS adapter mocking in `ingest-consumer.test.ts` (to script 429/503/404 responses) and INGEST_QUEUE `send()` capture into an in-memory array (to avoid enqueueing real messages that the production consumer would actually process).
- **Test safety:** DB/CACHE test bindings replaced with throwing Proxy. Instead of unsafe empty-object casts, now throws descriptive error if binding accessed without proper mock setup.

### Documentation

- **lib/README.md:** module table now lists `http/rate-limit.ts`, `http/circuit-breaker.ts`, and `observability/audit-abuse.ts`, which existed and were in use but missing from the table.

### Planned / Deferred

- **Milestone I.5 (classification assist via Workers AI):** Deliberately deferred until the existing I.1–I.3 hybrid-search pipeline has real production traffic to measure. No open code work currently scoped; revisit once signal volume and search patterns justify it.
- **G.4 deploy-automation guardrail:** If a preview/staging tier is ever added (currently not planned per G.4's "stays simplified" environment decision), it must never point at production secrets or write bindings — spec §15.1. Kept as an explicit future constraint in ROADMAP.md rather than deleted.

## [0.1.0] — 2026-07-27

### Added

- **Phase 0 Foundation:** Complete pnpm workspace scaffold with strict TypeScript base config, Prettier, and shared ESLint base
- **Apps/Web:** Next.js 16 + Tailwind scaffold with API client wired to call Worker API only (spec 12.1)
- **Apps/API:** Hono Worker with middleware chain (request-id, security-headers, error-handler), route stubs, cron scheduler, queue consumer, and wrangler.toml with D1/KV/Queues bindings (spec 10.1)
- **Packages/Domain:** Role taxonomy, ATS provider enum, NormalizedJob/Signal/IngestMessage Zod schemas, and API envelope helpers
- **Packages/Adapters:** AtsAdapter interface implementation (spec 5.3)
- **Packages/DB:** D1 schema migration (0001_initial_schema.sql) with full schema from spec 8.2, parameterized D1 client wrapper (spec 11.1), and repository implementations for signals, companies, and facets
- **Database Repositories:** 
  - Cursor-paginated signal list (score_desc/newest/company_asc) with keyset pagination
  - Signal detail with signal_evidence rows (spec 9.3)
  - Company autocomplete search, get-by-slug, and recent-signals-for-company (spec 9.2, 10.5)
  - Role/source/location aggregate counts via D1 batch() round trip
- **API Routes:** GET /api/v1/signals, /signals/:id, /companies, /companies/:slug, /facets now query D1 through packages/db instead of returning stub data
- **Facets Caching:** 60s KV cache for facets route (spec 12)
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
