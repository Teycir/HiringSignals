# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **README accuracy pass:** Corrected several stale claims: migration count updated from 0001-0004 to 0001-0009 (all 9 landed); `apps/api` description now lists RSS feed route and hiring-trends route; CLI commands now include `hs feed-url` and `hs trends hiring`; `lib/` description corrected (RSS serializer added to text utilities, `safeRateLimitIdentifier` de-listed as a standalone item — it lives inside `rate-limit.ts`); ops scripts list now includes `update-company.mjs` and `ingestion-metrics.mjs`; semantic search status corrected from "write path only" to fully live (both write and query paths wired, Milestone I.3 complete).

### Removed

- **`apps/web` (dashboard) — deleted 2026-08-07:** Removed entirely, not deprioritized or left in place. Decided with the user that `apps/cli` (see ROADMAP.md Milestone F.1, shipped the same day) is the primary interface going forward, since the dashboard was a caller of `apps/api`'s existing routes and added no capability the API/CLI surface doesn't already have. The Added entries below for Milestone F (dashboard UI) and Milestone I.4 (search UI, which shipped inside `apps/web`) remain as an accurate historical record of work that was completed before this deletion — see ROADMAP.md Milestone F's header note for the full rationale.

### Planned

- **Milestone I — Semantic search (Workers AI + Vectorize):** Scoped in `ROADMAP.md`. I.1 (index + bindings), I.2 (embedding write path), and I.3 (query-side hybrid search, live on `GET /api/v1/signals`) done — see the Added entries below. I.4 (search UI) shipped inside `apps/web` and was removed along with it (see "Removed" above); its CLI-native equivalent isn't scoped yet. I.5 (classification assist) remains deliberately deferred until the rest of this milestone has run in production.

### Added

- **Milestone Q — Hiring velocity score per company (`packages/domain/src/hiring-velocity.ts`):** Investor-grade company-level score answering "how aggressively is this company building its team right now" — distinct from the existing per-signal score, which only ranks individual role-level postings. `computeHiringVelocity` (Q.1) is a pure function: `V = clamp(0.40*acceleration + 0.25*breadth + 0.20*volume_norm + 0.15*persistence, 0, 1) * 100`, reusing `computeAcceleration`/`computeBreadth` from `signal-score.ts` fed company-wide (all-role) counts instead of per-role ones. Persisted via three new nullable `companies` columns (`hiring_velocity_score`, `velocity_score_version`, `velocity_computed_at`; migration `0008_company_velocity_score.sql`) — null means not-yet-computed, never fabricated as 0. Q.2 wires a `handleVelocityRecompute` pass into the daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`), running once per company that had ≥1 signal genuinely reconciled that run via a new `getCompanyActivityStats` (`packages/db/src/company-role-stats-repo.ts`) and `updateCompanyVelocityScore` (`packages/db/src/companies-repo.ts`). Q.3 surfaces `hiringVelocityScore` on `GET /api/v1/trends/hiring` (new `sort=velocity_desc`, null scores sort last) and `GET /api/v1/companies`/`:slug`, plus a shared `HIRING_VELOCITY_DISCLAIMER` constant ("Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.", spec §11.3) in each response's `meta`. `hs trends hiring` picks up `velocity_desc` automatically via `Partial<TrendsQuery>`; JSON-only output, no `--format table` per F.1.1's CLI-wide decision. 13 new tests (12 hand-computed unit tests in `hiring-velocity.test.ts`; 1 live-D1 `velocity_desc` sort test in `trends-repo.test.ts` covering high/low/uncomputed companies) plus `api-client.test.ts` extended to round-trip the disclaimer field through `fetchHiringTrends`/`fetchCompanies`/`fetchCompanyDetail`. `pnpm -r typecheck` clean across all 6 workspace packages.
- **Milestone P — Hiring trend API: cross-company analytics (`GET /api/v1/trends/hiring`):** Market-intelligence layer beyond O's single-company timeline — "which fintechs started hiring ML in the last 60d," ranked companies rather than one company's history. `getHiringTrends` (P.2, `packages/db/src/trends-repo.ts`) aggregates job/signal activity per company via conditional-SUM queries against `idx_jobs_trends` (migration `0007_trends_role_first_seen_index.sql`), with `acceleration_desc`/`volume_desc`/`newest_signal`/`velocity_desc` sort options and a top-5-per-company location breakdown computed in code. Route (`apps/api/src/routes/trends.ts`) has a 5-minute KV cache keyed on every param that affects the result, with `resolveTrendsSince`/`buildTrendsCacheKey` extracted as pure, directly-unit-tested functions rather than folded into the handler. `hs trends hiring` (P.3, `apps/cli`) is the CLI surface, JSON-only per F.1.1. 6 live-D1 tests in `trends-repo.test.ts` (acceleration/volume/industry-filter/topLocations/zero-new-jobs-exclusion — later joined by Q.3's `velocity_desc` test above) plus route-layer pure-function tests in `apps/api/test/routes/trends.test.ts`. `pnpm -r typecheck` clean.
- **Milestone N — Saved filter profiles (`apps/cli`):** `hs signals list --save` persists the given filter flags (role/company/q/locationMode/country/source/signalType/minScore/observedSince — not sort/cursor/limit) to a local config file (`~/.hiring-signals/config.json`, or `$XDG_CONFIG_HOME/hiring-signals/config.json` when set). Running `hs signals list` with no filter flags and a saved profile present applies it automatically, printing a one-line `Using saved filters: ...` note to stderr so the behavior stays visible rather than silent (stdout stays pure JSON). `hs signals list --clear-saved` removes it. Stores raw pre-parse flag strings rather than `signalsQuerySchema`'s parsed/defaulted output, so saved profiles never silently pick up `sort`/`limit`/`minScore` defaults for fields the user never touched; invalid or corrupt saved JSON is silently discarded on load via `signalsQuerySchema.safeParse`, no versioning, no re-save prompt. New `apps/cli/src/config-store.ts`. 22 new tests (`config-store.test.ts`, `signals-list-saved-filters.test.ts`, the latter real `bin/hs.mjs` subprocess spawns); manually verified end-to-end against a live local `wrangler dev` instance.
- **Milestone R — RSS feed (`GET /api/v1/feed.rss`) + `hs feed-url`:** Closes the "notify me later" gap identified 2026-08-06 — push-style delivery via any feed reader, no accounts, no new infrastructure. `lib/text/rss.ts` (R.1) is a dependency-free RSS 2.0 serializer (XML-escaped, RFC 822 dates, `<link>` omitted for company-level aggregate signals with no job-linked evidence). `apps/api/src/routes/feed.ts` (R.2) serves it at `GET /api/v1/feed.rss`, capped at `FEED_ROW_CAP = 50` items via a new `listSignalsForFeed` in `packages/db/src/signals-repo.ts` (own constant/function, not `listSignalsForExport` reused with a caller limit — a feed's poll-frequency cap is a different concern from the CSV export's one-time-dump cap), with `ETag`/`Last-Modified`/`304 Not Modified` support and no KV caching. `hs feed-url` (R.3, `apps/cli`) prints the feed URL for a given filter set, reusing `signalsQuerySchema.omit(...)` and the same query-serialization helper the CLI's own HTTP calls use, so the printed URL can never drift from what the CLI would actually request. Not gated on Milestone F.1 — a feed URL is short enough to construct by hand. 13 new tests (7 serializer, 6 CLI URL-building); manually verified end-to-end against a live local `wrangler dev` instance, including the 304 conditional-request path.
- **Milestone F.1 — CLI (`apps/cli`), primary interface:** New `citty`-based workspace package, the primary interface now that `apps/web` is deleted. JSON-by-default on stdout, single-JSON-object machine-readable errors on stderr, no interactive prompts (admin actions require an explicit `--yes` instead). Thin client over `apps/api`'s existing routes only — no D1 access, no bypassing the API's own validation/rate-limiting/auth. Commands: `hs facets`, `hs signals list/get`, `hs companies list/get`, `hs sources list`, `hs export signals [--out <path>]`, `hs admin source run/scheduler flush/reconcile`. `signalsQuerySchema` moved from `apps/api/src/routes/signals.ts` into `packages/domain/src/signals-query.ts` so the route and the CLI validate against the exact same schema. Native Node TS execution required adding `node-typescript-resolver` (extensionless-import loader) plus a small re-exec wrapper (`bin/hs.mjs`) since this is the first package in the monorepo executed directly by Node rather than bundled — every other package's extensionless relative imports only ever had to resolve under `tsc`/wrangler's esbuild before now. Tests: `test/api-client.test.ts` (14, mocked `fetch`) and `test/cli-process.test.ts` (5, real subprocess spawns of `bin/hs.mjs` asserting exit code and stderr shape). See `apps/cli/README.md` for exact invocations/output per command. Known gap: the `--format json|table` flag originally scoped for F.1.1 was never implemented — JSON is the only output format; see ROADMAP.md Milestone F.1.1 for the note.
- **Milestone I.4 — Search UI (`apps/web`):** Free-text hybrid search bar (`search-bar.tsx`, debounced 250ms, wired into `signals-view.tsx`) sitting on top of the `FilterState.q`/`toApiParams` plumbing I.3 already built. SSR-safe recent-searches dropdown (`lib/searchHistory.ts`, localStorage, capped/deduped). `MoreLikeThisButton` on signal detail navigates to `/signals?q=<headline>`, reusing the same Vectorize similarity query the search bar runs rather than adding a new id-based lookup endpoint (spec §9.4 forbids a new query param for v1). AbstractSearch's dedicated paste-text-mode UI stays deferred, though the shipped search field already accepts long pasted text through the same `q` param.
- **Milestone F — Dashboard UI (`apps/web`):** Complete Next.js 16 Minimal Brutalist dashboard shell. Includes `/signals` feed route with responsive `FilterRail` (roles, company combobox with debounced autocomplete, preset score thresholds, sources, signal types, work modes, recency), `SignalCard` feed with cursor pagination, and loading/error/empty states (`signal-feed.tsx`). `SignalDetail` route (`/signals/[signalId]`) displays evidence table, score breakdown, and 7/30/90-day trend blocks. Shared `AppShell` with masthead navigation and mobile menu. Search params synchronized bi-directionally with browser URL via `lib/searchParams.ts`.
- **Milestone E — 6 additional ATS Adapters:** Ashby, Recruitee, Breezy, Personio, SmartRecruiters, Workable. Milestone E closed at 8 active ATS adapters with fixture-driven tests and location-mode inference.
- **CSV Export Endpoint (`GET /api/v1/export/signals.csv`):** Full export API accepting all signal filter parameters (`roles`, `company`, `q`, `locationMode`, `country`, `source`, `signalType`, `minScore`, `observedSince`). Returns RFC-4180 compliant CSV stream with a 2,000-row safety limit and `X-Export-Truncated` header. Backed by `exportSignals` in `packages/db/src/signals-export-repo.ts`.
- **Bulk Source Onboarding (`import-sources.mjs`):** Ops script for CSV-based batch company and source creation with pre-validation, duplicate skipping, and interactive confirmation.
- **Zero-Mocks Live Cloudflare Test Infrastructure (`packages/test-support`):** Remote transport layer, live D1 database client (`live-d1-client.ts`), and live KV/AI/Vectorize bindings (`live-cf-bindings.ts`) for end-to-end integration testing against real Cloudflare resources without mocks.

### Fixed & Security

- **Rate-limit Identifier Hashing (`lib/http/rate-limit.ts`):** Implemented `safeRateLimitIdentifier()` SHA-256 base64url hashing before key construction. Eliminates IPv6 colon separator injection (`2001:db8::1`) and key boundary confusion that previously allowed counter bleeding across shards (security review 2026-07-30 HIGH 1 finding). Scrubs plaintext IP PII from KV keys.
- **Trusted-First Client IP Resolution (`apps/api/src/middleware/client-ip.ts`):** Security fix enforcing trusted IP extraction (`CF-Connecting-IP` > last hop of `X-Forwarded-For` > `"unknown"`). Prevents client spoofing of `X-Forwarded-For[0]` to bypass rate limits (security review 2026-07-30 HIGH 3 finding).
- **Reopened Role Signal Refinement (`packages/domain/src/lifecycle.ts`):** Added a 3-day absence threshold (`daysSinceLastSeen >= 3`) before flagging a reappeared closed job as a `reopened_job` signal. Prevents single-run scrape glitches or transient ATS 4xx errors from triggering false reopened role signals.
- **Signal Detail Status Guard (`packages/db/src/signals-repo.ts`):** Restricted `getSignalDetail` to `s.status = 'active'` to prevent deleted or dormant signals from being returned in detail views.
- **Active Signal Query Optimization (`packages/db/src/signals-write-repo.ts`):** Replaced client-computed ISO dates with SQLite native `datetime('now', '-28 days')` in `findActiveSignal` and `findActiveSignalsBatch`.
- **Security Headers Middleware Response Wrapper (`apps/api/src/middleware/security-headers.ts`):** Fixed wrapper to pass through base middleware `Response`.

### Added

- **Milestone I.2 — Embedding write path:** Jobs are embedded (`buildJobEmbeddingText`) and upserted into the `hiring-signals-jobs` Vectorize index at ingest time (`embedAndUpsertJob` in `ingest-consumer.ts`), gated on new-or-content-changed jobs, wrapped in try/catch so an embedding failure never fails or retries the enclosing ingest message.
- **Milestone I.1 — Vectorize index + Workers AI binding:** Provisioned `hiring-signals-jobs` Vectorize index (768-dim, cosine, matching `@cf/baai/bge-base-en-v1.5`'s output) with metadata indexes on `companyId`/`roleCategory`/`locationMode`/`status`/`postedAt` (all string), created before any vectors exist so metadata filtering applies retroactively to every future insert. `[ai]`/`[[vectorize]]` bindings and `EMBEDDING_MODEL` var added to `apps/api/wrangler.toml`; `Bindings` interface updated to match. `wrangler deploy --dry-run` confirms all bindings resolve.
- **Milestone H — Signal-quality logic pass:** Real Volume/Acceleration/Breadth scoring (`score_version` v2, `packages/domain/src/signal-score.ts`), backed by a new `getCompanyRoleActivityStats` repo query (`packages/db/src/company-role-stats-repo.ts`). All four company-level signal types (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand`) now actually get created, not just typed. A description-channel classification-noise fix so an incidental phrase in a job description can no longer override a clean title+department match. A new daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`, `0 6 * * *` cron) recomputes stale active signals' scores without touching `last_detected_at`.
- **`/api/v1/admin/*` (spec §10.5a):** Re-added after the earlier no-auth removal, but narrowly scoped: three idempotent, secret-bearer-token-gated pipeline triggers (source-run, scheduler-flush, reconcile), never a login a user sees and never called from `apps/web`. Source add/edit is still local-ops-script-only.
- **Milestone E — Lever ATS adapter:** Full implementation following same pattern as Greenhouse (location inference, fixture-driven tests, malformed payload handling). Ingestion pipeline now supports both Greenhouse and Lever providers.
- **Milestone D — Source management ops scripts (spec §10.5):** `infrastructure/scripts/add-source.mjs`, `update-source.mjs`, `source-health.mjs` (plus shared `lib/d1-exec.mjs` helper) — plain Node, shell out to `wrangler d1 execute --json` since a live `D1Database` binding only exists inside a Worker, not a plain CLI process. No HTTP surface; matches the no-auth decision below. Manual ingestion trigger is `update-source.mjs --run-now` (clears `next_poll_at` so the real scheduler picks it up) rather than pushing directly onto the queue, since Cloudflare Queues has no CLI send verb.
- **Milestone D — Write pipeline:** `apps/api/src/jobs/scheduler.ts` (cron finds due sources via `getDueSources`, enqueues one `IngestMessage` per source with deterministic per-source jitter, never fetches directly — spec §5.1/§5.2) and `apps/api/src/jobs/ingest-consumer.ts` (full fetch → validate → normalize → upsert → observe → lifecycle → classify → score → signal pipeline, idempotent per `(sourceId, runId)`, every §10.4 failure branch — 429, transient 5xx, 4xx config error, schema mismatch, retry exhaustion — handled as its own branch rather than a generic catch-all). Complete running system, 94 tests passing workspace-wide.
- **Company creation:** `createCompany` write-repo function and `add-company.mjs` ops script with slug uniqueness validation, duplicate detection, and proper error handling.

### Changed

- **Test organization:** All `*.test.ts` files moved from `src/` into sibling `test/` directories across all packages (apps/api, packages/adapters, packages/db, packages/domain). Import paths updated to relative `../src/*` references. Each package's tsconfig includes `test/**/*.ts` for typecheck coverage.
- **Error handling centralization:** `isUniqueConstraintError` helper moved from internal package location to `lib/d1/unique-constraint.ts` (same home as `lib/d1/like-pattern.ts`). All three call sites (sources-repo.ts, companies-repo.ts, ingest-consumer.ts) now import from single source. Deleted empty `packages/db/src/internal/` module.

### Removed

- **No-auth decision (project-wide):** The app has no login and is public/free for anyone, permanently — not a temporary demo posture. Removed `/api/v1/admin/*` HTTP surface entirely (`apps/api/src/routes/admin.ts` deleted, unmounted from `apps/api/src/index.ts`); source management (add/edit source, manual ingestion trigger, health check) is now a local ops script against D1 (`infrastructure/scripts/`, spec §10.5), never a Worker route. Removed `protectedWriteTier` from `apps/api/src/middleware/anti-abuse.ts` (no remaining caller) and deleted `lib/http/turnstile.ts` (its only consumer). Removed `TURNSTILE_SECRET_KEY` from `apps/api/src/bindings.ts` and narrowed `Variables.abuseVerdict` to `"ok" | "rate_limited"` (the CAPTCHA-related states are no longer reachable). `hiring-signals-spec.md`, `ROADMAP.md`, `AGENTS.md`, and `README.md` updated throughout.

### Fixed

- **Signal freshness scoring:** `daysSinceObservation` was hardcoded to 0 at signal creation, making the score's R (freshness) component always e^0=1. Jobs scraped 120 days after posting scored identically to jobs posted today, flooding the top of the signal feed with stale listings. Now anchors on `job.postedAt` when provided by source, falling back to `existing.first_seen_at` (earliest observation) when adapter omits postedAt, and finally `observedAt` as last resort. Feeds real elapsed days into `computeNewJobScore`.
- **Active signal deduplication:** `findActiveSignal` previously matched any `status='active'` signal for a (company, role, type) triple regardless of age. Hiring bursts resuming after multi-month lulls were silently folded into old dormant rows instead of creating fresh signals. Added `ACTIVE_SIGNAL_LOOKBACK_DAYS=28` and bound query on `last_detected_at` so stale-but-still-'active' rows (pending expiration cron sweep) no longer count as dedup matches.
- **Ingest consumer retry logic:** Provider validation errors and schema mismatches (programmer/config errors) now skip retry and set correct `source_run.status` and `error_code`. Only network failures (429, 5xx) trigger exponential backoff retry. Prevents infinite retry loops on permanent failures.
- **Classification threshold bug:** `classifyJob`'s auto-classify threshold for multi-location signals was unreachable due to logic error. Fixed condition evaluation.
- **`job_observations` idempotency gap (ROADMAP.md Milestone A):** Migration 0001 never put a UNIQUE constraint on `(job_id, source_run_id)`, so a retried queue message could insert a duplicate observation row, silently corrupting missing-run-count and lifecycle math (spec §10.3's idempotency requirement). Added `0004_job_observations_idempotency.sql` (`CREATE UNIQUE INDEX idx_job_observations_idempotency`, SQLite has no `ALTER TABLE ADD CONSTRAINT`), applied and verified against local D1 (constraint fires on duplicate insert).
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
