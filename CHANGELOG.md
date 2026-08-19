# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-08-19

### Added (2026-08-19)

- **New `GET /api/v1/signals/stats` endpoint.** Descriptive statistics (count, min/max/mean/median/p25/p75 of `score`, plus per-`signalType` and per-`roleCategory` breakdown counts) over the same filter surface as `GET /api/v1/signals` (`roles`/`company`/`q`/`locationMode`/`country`/`source`/`signalType`/`minScore`/`observedSince`) — `sort`/`cursor`/`limit` don't apply since a stats aggregate has no pagination or ranking. Percentiles/mean are computed in application code (`getSignalStats`, `signals-repo.ts`) over raw scores pulled with a defensive row cap, since D1/SQLite has no `PERCENTILE_CONT`; a `truncated` flag on the response signals when that cap was hit, though `count`/`bySignalType`/`byRoleCategory` are always exact (plain `COUNT`/`GROUP BY`). New `fetchSignalStats` added to `apps/web/src/lib/api-client.ts`.

- **Automated deployment pipeline via GitHub Actions.** New `.github/workflows/deploy.yml` automatically deploys `apps/api` and `apps/web` to Cloudflare Workers on main branch pushes, with manual trigger support via `workflow_dispatch`. Deployment includes typecheck and lint to ensure code quality before deployment. Requires `CLOUDFLARE_API_TOKEN` GitHub secret for authentication. Added `.github/DEPLOYMENT.md` with deployment workflow documentation and secret setup instructions.

- **Pre-push quality gate enforcement.** Added git pre-push hook that runs typecheck and lint locally before allowing any push to remote, ensuring CI/CD quality gates are enforced before code reaches the CI pipeline. Setup script `scripts/setup-pre-push-hook.sh` provided for easy installation.

### Fixed (2026-08-19)

- **Acceleration scoring saturated to 1.0 for most companies on a young dataset.** `computeAcceleration` (spec 7.2) compares a company+role's last-14-day new-job count against its prior-56-day rate — but with no ingestion history yet, `newInPrior56Days=0` isn't "zero growth," it's "no baseline." Feeding that through the relative-rate formula collapsed the denominator to its floor, so any `newInLast14Days >= 2` clamped straight to 1.0 regardless of whether it was 2 or 200 — confirmed live, where 11 of 14 companies with jobs were already pinned at exactly 1.0, making the `/trends` chart's top-N ranking arbitrary among ties. `computeAcceleration` now special-cases `newInPrior56Days=0` with an absolute scale on `newInLast14Days` instead of the relative-rate comparison. `SCORE_FORMULA_VERSION` bumped `v2` → `v3` so `signal_evidence` rows scored before/after this change stay distinguishable, per spec 7.2's recomputability requirement.

## [1.2.0] — 2026-08-19

### Added (2026-08-19)

- **`/trends` now renders a chart, not just a table.** `hiring-signals-spec.md` §2.3 listed "trend charts" as explicitly deferred P2; promoted to §2.2 P1 and built. New `TrendsChart` component (`apps/web/src/components/trends-chart.tsx`, `recharts`) renders a horizontal bar chart of the top 8 companies by whichever metric the page's active sort represents (acceleration/velocity/new-job volume) — no new endpoint, it's the exact same `GET /api/v1/trends/hiring` response `TrendsTable` already renders below it. Strict ink/paper/muted styling per the app's monochrome design tokens (`globals.css`); `--accent` used only on the #1-ranked bar, matching how `VelocityBadge` already reserves that color for a single highlighted state rather than coloring every series. `hiring-signals-spec.md` §9.2's endpoint table also updated to list `/api/v1/trends/hiring`, `/companies/:slug/timeline`, and `/companies/:slug/role-activity` — all three were already built (Milestones P.2, O.1, V.4) but had never been added to that table.

### Changed (2026-08-19)

- **`/signals` no longer accumulates results into one unbounded, ever-growing list.** The feed's "Load more" button appended each new batch onto the existing list forever — after a few clicks (or on a broad/default query) the page became a very long scroll with no way to jump back to a specific spot. Replaced with page-scoped navigation: each page shows at most 15 signals (`DEFAULT_LIMIT`, `searchParams.ts`, down from the fetch batch size of 50), and moving to a new page replaces the visible list rather than appending to it. Still cursor-based under the hood (this API has no stable row offset to page by, spec §12's "use cursor pagination"), so `signal-feed.tsx` caches every visited page's items plus the cursor that reaches the next one; page position is not URL-addressable/bookmarkable (cursor was already deliberately excluded from the URL, see `serializeFilterState`'s own comment) and resets to page 1 whenever a filter changes.

- **`/signals` pagination now has clickable page numbers (1 2 3...), not just Previous/Next.** A previously-visited page number re-shows its cached items instantly, with no refetch. Because the API has no stable offset to jump to, a number beyond the pages already reached isn't shown or clickable yet — reaching it requires walking forward one page at a time first (via Next or an in-range number), which then reveals it.

- **Page navigation on `/signals` no longer replaces the card list with a skeleton, which was reflowing the page height and visually disturbing the fixed-width filter sidebar next to it on every Previous/Next/page-number click.** The skeleton (6 short placeholder blocks, noticeably shorter than a full page of up to 15 cards) is now shown only on true first load, when there's nothing on screen yet. A page navigation instead dims the current page's cards in place while the new page loads (or resolves instantly from cache), keeping the content column's height roughly stable and the sidebar undisturbed.

### Fixed (2026-08-19)

- **`/signals` showed "signal is aborted without reason" as a hard error, e.g. right after navigating from `/trends`.** `signal-feed.tsx`/`trends-view.tsx` intentionally cancel an in-flight fetch when filter state changes mid-request (`AbortController.abort()`), then use `isAbortError()` to swallow that cancellation silently. But `api-client-core.ts`'s shared `apiRequest()` caught *every* `fetchImpl` rejection — including the abort — and re-wrapped it into a generic `ApiClientError("NETWORK_ERROR", err.message, ...)`, which strips the original `DOMException`'s type identity. `isAbortError()`'s `err instanceof DOMException` check then failed (the error was now an `ApiClientError`), so the cancellation fell through to the real error UI, displaying the aborted fetch's own default message verbatim. `apiRequest()` now re-throws an `AbortError`-named rejection unchanged instead of wrapping it; `isAbortError()` now checks `err.name === "AbortError"` structurally rather than `instanceof DOMException` (this file's tsconfig has no DOM lib, so this also fixes a latent cross-runtime fragility, not just this bug).

- **Workable adapter schema never matched the real public board payload.** The schema modeled a nested `location: { location_str, country_code, ... }` object and a required top-level `id`, neither of which the real endpoint returns; the adapter's own test fixture was hand-written to match those assumptions rather than captured from a live board, so `pnpm test` stayed green while every real Workable board silently failed Zod validation in production (`WorkableSchemaError` on every job → `config_error` → source disabled), or "succeeded" with zero jobs on an account whose board happened to be empty — indistinguishable from a working adapter without checking a real board directly. Re-verified live (`apply.workable.com/api/v1/widget/accounts/{account}?details=true`, confirmed byte-identical to the `www.workable.com/api/accounts/...` fetch target after its 302): no top-level `id` (shortcode is the only stable identifier), no nested `location` object (`country`/`city`/`state` are flat top-level strings; `locations[]` entries use camelCase `countryCode`), and a single `description` field (raw HTML) rather than the previously assumed four-field split. `packages/adapters/src/workable.ts` rewritten against the real shape; a job missing `shortcode` now throws `WorkableSchemaError` rather than silently falling back to a derived id. Fixture and all 16 `workable.test.ts` tests updated to match (113/113 adapters package tests passing).

- **A `schema_mismatch` ingest failure never archived the raw payload that caused it.** Raw-response archival (`storeRawPayload`, KV, 30-day TTL) ran only after `adapter.normalize()` succeeded, so the one failure case where the raw evidence matters most — schema validation rejecting what the board actually sent — left `source_runs.raw_payload_key` `NULL`, with nothing left to inspect. Found investigating an `OpenAI`/`ashby` source that disabled itself on a `schema_mismatch` with `http_status=200` and an unparseable body (`response.json()` threw, so `rawBody` stayed `undefined`) — no way to tell a genuine API contract change from a one-off transient glitch without the original response. `apps/api/src/jobs/ingest-consumer.ts`: archival now happens immediately after the retryable-status checks (429/5xx/4xx) and before `adapter.normalize()`'s try/catch, so it runs on every path that reaches that point, success or schema failure alike; `finalizeConfigError`'s `schema_mismatch` call site now threads the archived key through into the failed run's own `source_runs` row.

## [1.1.2] — 2026-08-19

### Fixed (2026-08-19)

- **`/trends` showed identical NEW and ACTIVE counts for every company (e.g. 46/46, 19/19, 89/89).** `getHiringTrends`'s SQL computes `new_jobs_count` as jobs first seen within a `since` window and `active_jobs_count` as jobs currently `active`/`possibly_closed` (no date bound) — genuinely different conditions, not a query bug. But the route's `since` default was 30 days, and this dataset's ingestion only started 2026-07-26 (confirmed via `SELECT MIN(first_seen_at) FROM jobs`, and `active_older_than_30d` was 0 across all 6,779 rows), so every currently-active job for every company also happened to be "new" within that 30-day window — the two columns coincided for the dataset's entire life so far. `apps/api/src/routes/trends.ts`: `DEFAULT_SINCE_DAYS` changed 30 → 7, a standard "new this week" window that will diverge from ACTIVE almost immediately regardless of dataset age. `resolveTrendsSince`'s doc comment and `apps/api/test/routes/trends.test.ts`'s default-window assertion updated to match; stale "30d-ago" mentions in `apps/web/src/lib/api-client.ts` and `packages/domain/src/trends-query.ts` corrected to "7d-ago". `packages/db/test/trends-repo.test.ts` needed no change — it calls `getHiringTrends` directly with its own `since`, decoupled from the route default.

## [1.1.1] — 2026-08-19

### Fixed (2026-08-19)

- **`returnMetadata: false` silently broke the `like`/semantic-search Vectorize queries.** `env.VECTORIZE.query()` mis-serializes the boolean `false` for `returnMetadata`, throwing `VECTOR_QUERY_ERROR (code = 40026): Failed to parse the request body as JSON: returnMetadata: expected value` — caught by the surrounding `try/catch` and silently degraded to an empty result, indistinguishable from "no matches" without checking the logs. `apps/api/src/services/semantic-search.ts`: both call sites (`findSemanticSignalMatches`, `findSimilarSignalsByJobId`) now pass `returnMetadata: "none"` instead. Confirmed via live log evidence: the exact `VECTOR_QUERY_ERROR` present before the fix, absent on every request after it.

- **`findSimilarSignalsByJobId`'s "similar jobs" lookup silently inherited a 30-day filter it was never meant to have.** It called `findSignalsByJobIds(client, neighbourJobIds, { minScore: 0 })` without an explicit `observedSince`, so `buildCommonFilters` applied its own default of "last 30 days" — contradicting the `like` capability's own spec (9.4), which defines it as filter-free. Not visible in earlier testing only because the test data happened to fall inside the 30-day window. Fixed by passing `observedSince: new Date(0).toISOString()` explicitly to defeat the default.

## [1.1.0] — 2026-08-18

### Fixed (2026-08-18)

- **`/signals` and `/trends` rendered fully blank for up to several seconds on a cold load.** Both routes wrap a `useSearchParams()`-using client component in `<Suspense>` (required by Next since that hook needs a Suspense boundary), but the fallback was `<AppShell>{null}</AppShell>` — the masthead rendered, but the entire content column stayed empty with zero indication anything was loading while the client bundle for `SignalsView`/`TrendsView` downloaded and hydrated. New `PageLoadingSkeleton` component (`apps/web/src/components/page-loading-skeleton.tsx`) renders immediately with no client JS or data fetch required, matching the existing post-mount skeleton styling already used in `signal-feed.tsx`/`trends-view.tsx` (`border-2 border-ink ... animate-pulse` blocks) so there's no visual jump once the real component mounts.

- **`/trends` required manually selecting a role before any data loaded.** Landing on a bare `/trends` URL showed "select at least one role" instead of populating results — `parseRoles` returned `[]` whenever the URL had no `roles` param, which is exactly the state of a fresh page load. `trends-view.tsx`'s `parseRoles` now defaults to `software_engineering` (`ROLE_CATEGORIES[0]`) specifically when the `roles` key is absent from the URL entirely, while still respecting an explicit empty selection: `updateParams` now writes `roles=` (empty string, not a deleted key) when every chip is deselected, so the default only fires on a genuinely fresh landing and a user can still clear every role without it snapping back.

- **Stale "8 providers" copy in `/signals`' page metadata description**, left over from the Breezy removal below (now 7).

- **Duplicate changelog entry.** This file's own `## [Unreleased]` section had accidentally duplicated the entire `hs --version` / `hs -v` entry twice under `### Added (2026-08-17)`. Removed the duplicate.

- **Remaining Breezy trace across code, docs, and remote D1**, left behind after the adapter itself was removed in an earlier pass. Found via an exhaustive case-insensitive repo-wide grep and fixed file by file: the dead `sources` row and its now-sourceless company were deleted from D1 (previously left to degrade in place per the old spec design); leftover comment mentions removed from `registry.ts`, `index.ts`, `providers.ts`, `personio.ts`, `import-sources.mjs`, `add-source.mjs`; live user-facing copy on `/how-to-use` and `/faq` fixed (was still claiming "8 ATS providers... Breezy"); `seed-local-d1.sql`'s synthetic `ironcladsecurity` fixture company swapped from `breezy` to `ashby` (source row + 3 job URLs) to keep local dev seed data provider-accurate; `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `llm.txt`, `hiring-signals-spec.md`, `project-metadata.json`, and migration `0009`'s SQL comment reworded to drop the provider name while preserving the true underlying history (adapter removed 2026-08-18, dead board); the dedicated "Removed: Breezy adapter" changelog entry deleted outright rather than reworded, since it existed purely to describe the removal.

- **SmartRecruiters adapter failing on every real board (`consecutive_failures`, `enabled: 0` on the one live production source).** A production audit of the lowest-source-count provider found SmartRecruiters' API is live and returning real postings today, but the adapter's `normalize()` required `posting.actions.details.url` or `.apply.url` to build a `canonicalUrl`, and a live-data check showed every posting from a real board now returns an empty `actions: {}` — SmartRecruiters stopped populating those fields in its list response at some point after this adapter was written (2026-07-30). `packages/adapters/src/smartrecruiters.ts` now synthesizes the canonical URL from `posting.id`/`uuid` + the source's `boardToken` (`https://jobs.smartrecruiters.com/{boardToken}/{postingId}`, confirmed live: resolves 200 for a real posting) whenever the response doesn't supply one directly, still preferring the response's own action link when present. 3 new tests in `smartrecruiters.test.ts` against a new `smartrecruiters-board-no-actions.json` fixture matching the real live response shape (18/18 passing). This provider was **not** removed.

- **React best practices violations in web UI.** Removed unused
  `eslint-disable` directives in `cloudflare-env.d.ts`, fixed
  `setState-in-effect` warning in `signal-feed.tsx` by moving
  `setSourceStatus` into async callbacks instead of the effect body,
  and removed unused `ApiClientError` import in `trend-block.tsx`.

### Changed (2026-08-18)

- **Job pagination consistency and type safety.** Updated
  `encodeJobsCursor` to use `title_normalized` instead of
  `title_raw` for cursor-based pagination consistency with database
  sort order. Refactored `listJobsForCompany` to use the `LocationMode`
  type instead of raw strings. Improved `getJobById` error handling to
  gracefully degrade when encountering corrupt rows that fall outside
  domain enum constraints. Added integration tests for pagination using
  `oldest` and `title_asc` sort modes.

### Added (2026-08-18)

- **Raw job read surface: `GET /api/v1/companies/:slug/jobs`, `GET
  /api/v1/jobs/:jobId`, `hs companies jobs <slug>`, `hs jobs get
  <jobId>`.** Closes a real gap: no route or CLI command ever exposed
  the raw `jobs` table (department, employment type, requisition ID,
  classification confidence, first/last-seen) -- only derived signals
  (which expire) and aggregated timeline buckets (counts only) were
  queryable. Built as a full vertical slice mirroring `signals
  list`/`signals get`'s own conventions end to end: `packages/domain`
  gets `jobsQuerySchema`/`jobIdParamSchema`; `packages/db`'s
  `jobs-repo.ts` gets `listJobsForCompany` (cursor-paginated, same
  fetch-one-extra-row-for-nextCursor + per-row corrupt-row-degrade
  pattern as `listSignals`, `InvalidJobsCursorError` mirroring
  `InvalidCursorError`) and `getJobById` (full detail plus an
  `observationCount` derived from `job_observations`, so a caller sees
  how many times a posting was actually confirmed present without a
  separate evidence lookup); `apps/api` mounts the two new routes;
  `apps/cli` gets `fetchCompanyJobs`/`fetchJobDetail` plus the two new
  commands, `hs jobs get` skipping `--format table` (no honest
  single-row flattening for `JobDetail`'s free-text fields, same
  reasoning `hs companies get` already documents for itself). 18 new
  live-D1 tests in `packages/db/test/jobs-repo.test.ts`
  (`listJobsForCompany`/`getJobById`/`toJobListItem` describe blocks,
  appended alongside that file's existing `getDetectionLatencyStats`/
  tenant-isolation/`requisitionId` coverage -- zero mocks, zero fakes).
  spec §9.2's endpoint table and a new §9.3a document the two routes
  and the jobs-list query params. `packages/db`, `packages/domain`,
  `apps/api`, `apps/cli` all typecheck and lint clean.

### Added (2026-08-17)

- **`hs --version` / `hs -v`.** `apps/cli`'s root `citty` command declared
  a `meta.version`, but this file uses `runCommand()` (not `runMain()`)
  for its JSON-error-shape contract, and only `runMain()` wires up
  citty's builtin `--version`/`-v` handling — so the flag was silently
  inert, and `meta.version` itself had been hardcoded `"0.0.0"` all
  along (never matched `apps/cli/package.json`, made worse by the
  v1.0.0 release below). Fixed by hand-checking `--version`/`-v` as the
  sole argument in `main()` (mirroring the existing `--format`
  extraction pattern) and reading the version live from
  `apps/cli/package.json` via a `with { type: "json" }` import instead
  of a literal, so it can't drift out of sync again. 3 new subprocess
  tests in `cli-process.test.ts` assert against the live `package.json`
  value rather than a hardcoded string, and confirm `-v` doesn't
  shadow a subcommand's own flags when other arguments are present.

- **`hs signals list --watched`.** Filters signals to the local
  watchlist companies (`hs companies watch <slug>`), mirroring the
  pattern `hs companies list --watched` already established.
  `signalsQuerySchema.company` is a single server-side value (not a
  comma-separated list like `--role`), so `--watched` fans out one
  `GET /api/v1/signals` request per watched slug -- applying every
  other filter flag (`--role`, `--q`, `--min-score`, etc.) to each --
  and merges/sorts/caps the results client-side. Design decisions,
  each matching an existing precedent in this codebase: `--watched`
  overrides `--company` when both are given (same as `companies list
  --watched` overriding `--q`); `--cursor` is silently dropped under
  `--watched` since a single server-side page token is meaningless
  once N per-slug requests are merged (`--limit` still applies, as a
  per-slug cap before the merge); per-slug failures are isolated via
  `Promise.allSettled` into `meta.failures` rather than failing the
  whole command; an empty watchlist succeeds trivially with no API
  call; `--watched` composes with `--watch` (polling) by re-fanning-out
  every tick; `--watched` is excluded from `FILTER_FLAG_KEYS`/`--save`
  since it's a data-source selector, not a filter value. The
  client-side sort comparator was written to exactly match
  `packages/db`'s real `ORDER BY` for all three sort modes, including
  `company_asc`'s `id DESC` tiebreaker (not `score DESC`, which the
  first draft assumed). Verified end-to-end against a live local
  `wrangler dev` API with real data (GitLab/Robinhood/Stripe) --
  merging, sorting, table rendering, and `--watch` polling all
  confirmed working. 7 new tests in
  `apps/cli/test/signals-list-watched.test.ts`, mirroring
  `companies-watchlist.test.ts`'s structure; full `apps/cli` suite
  (111 tests, 8 files) passing with no regressions.

## [1.0.0] — 2026-08-17

### Fixed (2026-08-17)

- **W.1 — CSP nonce blocked hydration/data fetch on every page (production).**
  Production `script-src 'self'` had no `unsafe-inline`, hash, or nonce, but
  the App Router embeds inline `<script>` tags on every response for RSC
  hydration — those were silently blocked, React never mounted, and
  `/signals`' client-side data fetch never fired (visible as a permanently
  empty page). Fixed with the officially documented Next.js pattern:
  `apps/web/src/middleware.ts` mints a fresh nonce per request and threads
  it through the CSP header; `apps/web/src/app/layout.tsx` adds
  `export const dynamic = "force-dynamic"` so the nonce reaches every
  route's scripts, not just the ones that happened to already be
  server-rendered (a purely static page still ships and needs to hydrate
  React, so it needed the nonce too). The static CSP header was removed
  from `next.config.ts` entirely, since a nonce is inherently per-request
  and can't be expressed there. Kept the deprecated `middleware.ts`
  filename rather than Next 16's `proxy.ts` rename: `@opennextjs/cloudflare`
  (this repo's deploy adapter) does not yet build `proxy.ts` correctly —
  confirmed via an actual failed `opennextjs-cloudflare build`, matching
  open upstream issues (`cloudflare/workers-sdk#13937`, `#13755`,
  `opennextjs-cloudflare#962`). Documented in-file as a deliberate,
  temporary compatibility shim with a concrete migration trigger (revisit
  once OpenNext ships Node.js middleware/Proxy support), not a permanent
  choice. Verified end-to-end: `opennextjs-cloudflare build` + local
  Workers-runtime preview served a 200 with a matching nonce on every
  `<script>` tag, and a live browser check showed zero console errors,
  zero CSP violations, and real signal data (OpenAI/Acme Corp/Globo Labs
  entries with facet counts) rendering where the page was previously a
  dead empty shell.
- **W.2 — Masthead "last sync" and `SignalFeed`'s staleness check permanently
  stuck on "pending" (snake_case/camelCase field mismatch).**
  `apps/web/src/lib/api-client.ts` declared its own local `SourceSummary`
  interface with a snake_case field (`last_success_at`) that never matched
  the real API response shape — `packages/db/src/sources-repo.ts`'s
  `toSummary()` (the function that actually builds `GET /api/v1/sources`'
  JSON body) has always returned camelCase (`lastSuccessAt`). Because the
  two interfaces lived in different packages, `tsc` had no way to catch
  the drift — apps/web's own (wrong) type was internally consistent, it
  just didn't describe what the server actually sends. Every
  `.map((s) => s.last_success_at).filter(Boolean)` therefore dropped every
  source unconditionally, so `masthead.tsx`'s `useLastSync` hook and
  `signal-feed.tsx`'s empty-feed staleness check (added by V.2, see
  "Added" below) both silently no-opped regardless of real sync activity.
  Fixed by correcting
  `SourceSummary` to `lastSuccessAt` in `api-client.ts` (with a comment
  pointing at `sources-repo.ts` as the source of truth) and updating both
  call sites. Verified live: local Workers-runtime preview of `/signals`
  now shows `last sync: 26m ago` instead of being stuck on "pending".
- **W.3 — `GET /api/v1/signals/:signalId` 500ing in production: migration
  0010 never applied to the remote D1 database.** Discovered while
  verifying the `/signals/[signalId]` `generateMetadata` fix below (V's
  server/client split surfaced a live bug that had been silently broken
  independently of today's work). `packages/db/src/signals-repo.ts`'s
  `getSignalDetail` query selects `score_freshness`/`score_volume`/
  `score_acceleration`/`score_breadth`/`score_confidence` — the five
  columns added by `infrastructure/d1/migrations/0010_signal_score_
  components.sql` (ROADMAP V.3) — but that migration file had only ever
  been run locally; `wrangler d1 migrations list hiring-signals --remote`
  showed it still pending against production. Every single-signal detail
  request therefore threw `D1_ERROR: no such column: s.score_freshness`
  (confirmed via `wrangler tail`) and the API returned a generic 500 with
  no indication of the missing-column cause. `listSignals` and every
  other reader were unaffected — they use `BASE_SELECT`, which never
  references the score-component columns. Fixed by running
  `wrangler d1 migrations apply hiring-signals --remote` (5 nullable
  `ALTER TABLE ADD COLUMN` statements, no data loss, no downtime observed).
  Verified live: `GET /api/v1/signals/:signalId` now returns `200` with
  `scoreComponents: null` for pre-migration rows exactly as
  `signals-repo.ts`'s own null-until-migrated convention documents.
- **W.4 — `apps/web`'s `generateMetadata` (companies/[slug],
  signals/[signalId]) silently served the generic fallback title in
  production, root-caused via two stacked issues.** First: deploying
  `apps/web` after adding `generateMetadata` still showed the generic
  title live, despite working in local preview. Cause:
  `NEXT_PUBLIC_API_BASE_URL` (from `.env.production`) only gets inlined
  into *client*-side bundles at `next build` time; server-side code
  (`generateMetadata`, any Server Component) reads `process.env` at
  *request* time inside the deployed Worker, and nothing wired
  `.env.production`'s value into that runtime `process.env` -- confirmed
  via `grep` on the built `worker.js` bundle (the URL string was absent
  entirely). Fixed by adding a `vars` entry to `apps/web/wrangler.jsonc`
  (the mechanism that actually populates a deployed Worker's runtime
  `process.env`). That fix surfaced a second, more fundamental problem:
  every server-side fetch to the API Worker's public
  `hiring-signals-api.teycircoder14.workers.dev` hostname returned
  Cloudflare error 1042 ("Worker tried to fetch from another Worker on
  the same account over a public workers.dev hostname, disallowed for
  security/loop-prevention reasons") -- confirmed via `wrangler tail`
  showing the raw non-JSON `"error code: 1042"` response body, which
  `api-client.ts`'s `res.json()` then failed to parse. Both
  `generateMetadata` catch blocks had a bare, unlogged catch-all that
  masked this entirely -- fixed those first to log any non-NOT_FOUND
  error via `console.error` (reaches Cloudflare Workers Logs, this
  Worker has `observability.enabled`), which is what actually surfaced
  the 1042 message. Root fix: added a Cloudflare service binding
  (`apps/web/wrangler.jsonc`'s `services: [{ binding: "API", service:
  "hiring-signals-api" }]`) -- Cloudflare's documented, architecturally
  correct answer for Worker-to-Worker calls on the same account (routes
  directly between Workers, no public-internet round-trip, no 1042
  check, also faster). `api-client.ts`'s `request()` now branches on
  `typeof window === "undefined"`: server-side calls resolve the binding
  via `getCloudflareContext().env.API.fetch()` (dynamically imported so
  `@opennextjs/cloudflare`, a server-only package, never reaches the
  client bundle), falling back to the public URL if the binding is ever
  absent; browser calls are unchanged and still use
  `NEXT_PUBLIC_API_BASE_URL` directly. Verified live:
  `GET /companies/openai` and `GET /signals/894a1174-...` both now serve
  real, fetched `<title>`/`<meta description>` in the initial HTML
  (`OpenAI | HIRING//SIGNALS`; `OpenAI: New role: Machine Learning
  Engineer, Integrity | HIRING//SIGNALS`), and the existing client-fetch
  rendering (browser -> API) was re-checked and is unaffected.
- **T.1–T.6 — CLI `--watch` and company-watchlist code-review findings.** All six issues from the 2026-08-17 review are resolved: T.1 (watch mode transient error handling), T.2 (watchlist partial failure handling), T.3 (config file error wrapping), T.4 (type casting cleanup), T.5 (watch mode replay design verified), T.6 (SIGINT/SIGTERM handling). Five were already fixed in the original feature implementation; T.5 was verified as acceptable design (current order prevents silent signal drops, replay window is negligible).

- **S.1 — CSV export formula-injection (spec §11.1).** `lib/text/csv.ts`'s
  `escapeCsvField` now prefixes any field whose first character is `=`,
  `+`, `-`, `@`, tab, or CR with a literal `'` before RFC-4180 quoting
  runs, neutralizing the CSV-injection vector (OWASP) that let untrusted
  upstream ATS data (company display name, job title) reach
  `GET /api/v1/export/signals.csv` as a live formula when opened in
  Excel/Sheets/LibreOffice. New tests: `apps/api/test/lib/csv.test.ts`
  (10/10 passing).
- **S.2 — CORS reflected-origin + credentials, plus a related OPTIONS
  preflight bug found in the same code path (spec §11.1).**
  `apps/api/src/middleware/security-headers.ts` no longer sets
  `Access-Control-Allow-Credentials: true` unconditionally alongside its
  by-design reflected-origin CORS. While fixing that, found and fixed a
  second, more serious bug in the same wrapper: `Access-Control-Allow-
  Origin`/`Vary` were being set via `c.header()` *after* the base
  middleware had already returned a finalized `Response` for OPTIONS
  preflight (`c.body(null, 204)`) — Hono does not apply `c.header()`
  calls made after a Response is already constructed, so every real
  cross-origin preflight was silently missing `Access-Control-Allow-
  Origin` and would have been blocked by the browser regardless of the
  credentials issue. Fixed by setting the origin-reflection headers
  before calling the base middleware. New tests:
  `apps/api/test/middleware/security-headers.test.ts` (4/4 passing,
  including a dedicated OPTIONS-preflight case).
- **S.3 — Admin-auth strike-counter KV race (spec §11.1).**
  `apps/api/src/middleware/admin-auth.ts`'s `addStrike` previously did a
  bare `kv.get` → `kv.put(strikes + 1, ...)` with no atomicity, letting a
  burst of concurrent wrong-password attempts from the same IP undercount
  strikes and stretch the 3-attempt/60s lockout past its intended
  threshold. Now routes through `incrementActiveShard` (exported from
  `lib/http/rate-limit.ts`, previously private to that file's sliding-
  window rate limiter — same atomic KV-`increment` primitive, reused
  instead of re-derived). Strike keys switched from a JSON blob requiring
  read-modify-write to a bare integer keyed on a fixed time bucket, so
  concurrent requests in the same window increment without racing.
  Existing live-KV integration suite (`apps/api/test/middleware/
  admin-auth.test.ts`, 14/14) passes unmodified, including the 3-strike
  lockout test.
- **U.1–U.2 — CLI/domain query-schema gaps (spec §9.4, hybrid search
  filter contract).** Added missing regression coverage for the
  already-fixed `trends.ts` CLI bug (invalid/missing/trailing-comma
  `--role`, `cli-process.test.ts` 12/12). Found and fixed
  `signalsQuerySchema.roles` (`packages/domain/src/signals-query.ts`)
  silently dropping a provided-but-empty `--role` value to `roles: []`
  (= "no filter") instead of erroring, unlike its `trendsQuerySchema`
  sibling — affected `hs signals list`, `hs export signals`,
  `hs feed-url`. Fixed with `.min(1)`, matching `trends-query.ts`.
- **U.3 — same bug duplicated, unfixed, on the public HTTP API.**
  `exportQuerySchema` (`apps/api/src/routes/export.ts`) and
  `feedQuerySchema` (`apps/api/src/routes/feed.ts`) are independent
  hand-copied schemas that never inherited U.2's fix — a direct HTTP
  call bypassing the CLI (`?roles=,` or `?roles=`) silently returned
  an unfiltered CSV export or RSS feed. Fixed both identically; the
  CLI's own `export`/`feed-url` commands were confirmed never
  vulnerable (already routed through the fixed domain schema).
- **U.4 — semantic search ranking bug (spec §9.4).**
  `apps/api/src/services/semantic-search.ts`'s
  `findSemanticSignalMatches` computed
  `bestSimilarity = Math.max(...byJobId.values())` identically on
  every loop iteration regardless of which job backed the current
  signal, so every hybrid-search result got the same similarity score
  whenever more than one signal was returned — silently erasing
  semantic ranking. Root-fixed (not score-capped): `findSignalsByJobIds`
  (`packages/db/src/signals-repo.ts`) now returns a new
  `SignalRow.matched_job_id` field via a correlated subquery scoped to
  the caller's own `jobIds` set, no second D1 round trip;
  `semantic-search.ts` looks up that job's real Vectorize score
  instead of the global max. New live-D1 regression test in
  `packages/db/test/signals-repo.test.ts` proves correct per-signal
  attribution. Verified: `packages/domain` 93/93, `apps/cli` 101/101,
  `apps/api` routes/lib 57/57, full live-D1 `findSignalsByJobIds`
  block 5/5; lint/typecheck clean across `db`/`domain`/`api`/`cli`.

### Added (2026-08-16 → 2026-08-17)

- **V.1–V.4 — `apps/web` UI wiring gaps closed (2026-08-17, commits
  `a44e09d`, `f78ed4f`, `9ab7be1`).** Four design deferrals/UX omissions
  found during a backend-integration audit of the web UI (ROADMAP.md
  Section V), all closed the same day:
  - **V.1 — root `/` redirects to `/signals`** instead of showing a plain
    text link (`f78ed4f`).
  - **V.2 — `SignalFeed` shows real "no data yet" / "sources may be
    stale" states** when the feed resolves empty with no active filters,
    instead of a generic empty-state message for all three cases
    (never-synced vs. stale vs. genuinely-filtered-to-nothing). Backed by
    a new `fetchSources()` call and `latestSuccessAt` staleness check
    (`f78ed4f`).
  - **V.3 — `ScoreBreakdown` renders real per-signal component values**
    (freshness/volume/acceleration/breadth/confidence) instead of a
    generic formula description. Backed by a new D1 migration
    (`0010_signal_score_components.sql`) persisting the five components
    at signal creation/refresh/score-update time, and `getSignalDetail`
    extended to return them (`f78ed4f`).
  - **V.4 — `TrendBlock` on the signal detail page shows real role-scoped
    7/30/90-day activity** (new/active job counts) instead of linking out
    to the company page. Backed by a new
    `GET /api/v1/companies/:slug/role-activity` endpoint and
    `getCompanyRoleActivity` in `companies-repo.ts` (`f78ed4f`).
  - **Masthead "last sync" fetch fix (`9ab7be1`, same day):** a narrower
    follow-up specifically for the masthead's own last-sync display,
    switching it to the centralized `fetchSources()` API client call
    (superseded the same day it landed — see W.2 above, a field-name
    mismatch this commit didn't happen to trigger but which still broke
    the same label under different conditions).

  Verified: `pnpm -r typecheck` clean; production build passes with
  every route dynamic per the W.1 CSP fix; live Playwright check showed
  real signal cards, facet counts, and score breakdowns rendering.

- **`apps/web` restored + brought up to current API contract (2026-08-16, commit `1bc7a97`):** Reverts the 2026-08-07 deletion of the Next.js dashboard and closes the gap against everything the API gained since (Milestones O, P, Q). Restored: signals list/detail, filter rail, search bar, company combobox, export button, score breakdown, evidence table, more-like-this, scroll progress, animated tagline, outreach prompt, role/source/signal-type/score/since/work-mode filters, search history (`lib/searchHistory.ts`), URL search-param sync (`lib/searchParams.ts`). New pages and components added to match the current API surface:
  - `/companies/[slug]` — company detail page with `CompanyTimeline` component rendering time-bucketed new/closed/active job counts with role/location breakdown (Milestone O).
  - `/trends` — cross-company hiring trend ranking with `TrendsView` (role chip-toggle, industry/country filters, sort selector) and `TrendsTable` (ranked company list, no charts, matches CLI framing of trends as secondary context per spec) (Milestone P).
  - `VelocityBadge` — renders `hiringVelocityScore` with the real acceleration/breadth/volume/persistence weights, an honest "not yet computed" state when null, and the live `HIRING_VELOCITY_DISCLAIMER` from the API response — never hardcoded (Milestone Q).
  - Masthead wired to `/trends`; signal cards and signal-detail link company names to `/companies/[slug]`; trend-block's former placeholder now links to the real company timeline.
  - `packages/db/src/types.ts`: `CompanyRecentSignal` moved out of `companies-repo.ts` into the shared types file so `apps/web` can import it without pulling in `D1Client`; `companies-repo.ts` re-exports it, no shape change.
  - Full workspace `pnpm -r typecheck` / `pnpm -r lint` clean; production build passes with `/companies/[slug]` and `/trends` in the route manifest.
- **`apps/web` Cloudflare Workers deploy target via OpenNext (2026-08-16, commit `878d181`):** Adds a real hosting target for the dashboard using `@opennextjs/cloudflare` (Cloudflare's current recommended Next.js 16 adapter, successor to next-on-pages). `apps/web/wrangler.jsonc` (`"hiring-signals-web"` Worker, same account as `apps/api`); `open-next.config.ts` (default config, no ISR routes yet); `package.json` `preview`/`deploy`/`cf-typegen` scripts; `.env.production` committed (force-added past `.gitignore`) pointing at the live API Worker URL — a public URL, not a secret. `eslint.config.mjs` updated to ignore `.open-next/**` and `.wrangler/**` to prevent false-positive lint errors from bundled runtime code. Verified: `opennextjs-cloudflare build` + `preview` serve `/`, `/signals`, `/trends` at HTTP 200 from real `workerd` runtime; CSP `connect-src` resolves to the production API origin confirming `.env.production` is read at build time.
- **FAQ and How-to-Use pages + Footer component (2026-08-16, commit `7409267`):** `apps/web/src/app/faq/page.tsx` — 12-question FAQ covering data sources, signal types, scoring, hiring velocity, freshness, login requirements, AI agent usage, and tech stack. `apps/web/src/app/how-to-use/page.tsx` — step-by-step usage guide. `apps/web/src/components/footer.tsx` — global footer component with navigation links, GitHub link, and attribution. `AppShell` updated to render the footer on all routes.
- **LICENSE file + README enhancements (2026-08-17, commit `29ef204`):** Added `LICENSE` (MIT, copyright 2026 Teycir Ben Soltane) so GitHub's license detector resolves correctly and the badge links to a real file. README updated: header badges and tagline wrapped in `<div align="center">`; donation block centered and wrapped in `<!-- donation:eth:start/end -->` markers; related-projects section wrapped in `<!-- related-projects:start/end -->` markers; new Services Offered section added with `<!-- services:start/end -->` markers; centered attribution footer with `<!-- attribution:start/end -->` markers; License section replaced inline MIT text with a concise bullet summary + `[LICENSE](LICENSE)` link.
- **API client consolidation (2026-08-17, commit `1904501`):** Extracted the request/error-envelope/query-serialization logic that had been independently hand-maintained in `apps/cli`'s and `apps/web`'s own API clients into a shared, platform-agnostic `packages/domain/src/api-client-core.ts`. `apps/web`'s param types now derive from the same Zod schemas `apps/cli` and the live API routes validate against, instead of a hand-copied set that had already drifted (see W.2 above for one concrete consequence of that drift). Zero call-site changes in either app. Verified: `pnpm -r typecheck` and lint clean on all 3 touched packages (`domain`, `cli`, `web`); `apps/cli`'s full suite (101 tests, including 22 live-network api-client tests) passing unchanged. Deployed the same day (`apps/web` Worker version `56084565`).

### Added

- **Milestone Q — Hiring velocity score per company (`packages/domain/src/hiring-velocity.ts`):** Investor-grade company-level score answering "how aggressively is this company building its team right now" — distinct from the existing per-signal score, which only ranks individual role-level postings. `computeHiringVelocity` (Q.1) is a pure function: `V = clamp(0.40*acceleration + 0.25*breadth + 0.20*volume_norm + 0.15*persistence, 0, 1) * 100`, reusing `computeAcceleration`/`computeBreadth` from `signal-score.ts` fed company-wide (all-role) counts instead of per-role ones. Persisted via three new nullable `companies` columns (`hiring_velocity_score`, `velocity_score_version`, `velocity_computed_at`; migration `0008_company_velocity_score.sql`) — null means not-yet-computed, never fabricated as 0. Q.2 wires a `handleVelocityRecompute` pass into the daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`), running once per company that had ≥1 signal genuinely reconciled that run via a new `getCompanyActivityStats` (`packages/db/src/company-role-stats-repo.ts`) and `updateCompanyVelocityScore` (`packages/db/src/companies-repo.ts`). Q.3 surfaces `hiringVelocityScore` on `GET /api/v1/trends/hiring` (new `sort=velocity_desc`, null scores sort last) and `GET /api/v1/companies`/`:slug`, plus a shared `HIRING_VELOCITY_DISCLAIMER` constant ("Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.", spec §11.3) in each response's `meta`. `hs trends hiring` picks up `velocity_desc` automatically via `Partial<TrendsQuery>`; JSON-only output, no `--format table` per F.1.1's CLI-wide decision. 13 new tests (12 hand-computed unit tests in `hiring-velocity.test.ts`; 1 live-D1 `velocity_desc` sort test in `trends-repo.test.ts` covering high/low/uncomputed companies) plus `api-client.test.ts` extended to round-trip the disclaimer field through `fetchHiringTrends`/`fetchCompanies`/`fetchCompanyDetail`. `pnpm -r typecheck` clean across all 6 workspace packages.
- **Milestone P — Hiring trend API: cross-company analytics (`GET /api/v1/trends/hiring`):** Market-intelligence layer beyond O's single-company timeline — "which fintechs started hiring ML in the last 60d," ranked companies rather than one company's history. `getHiringTrends` (P.2, `packages/db/src/trends-repo.ts`) aggregates job/signal activity per company via conditional-SUM queries against `idx_jobs_trends` (migration `0007_trends_role_first_seen_index.sql`), with `acceleration_desc`/`volume_desc`/`newest_signal`/`velocity_desc` sort options and a top-5-per-company location breakdown computed in code. Route (`apps/api/src/routes/trends.ts`) has a 5-minute KV cache keyed on every param that affects the result, with `resolveTrendsSince`/`buildTrendsCacheKey` extracted as pure, directly-unit-tested functions rather than folded into the handler. `hs trends hiring` (P.3, `apps/cli`) is the CLI surface, JSON-only per F.1.1. 6 live-D1 tests in `trends-repo.test.ts` (acceleration/volume/industry-filter/topLocations/zero-new-jobs-exclusion — later joined by Q.3's `velocity_desc` test above) plus route-layer pure-function tests in `apps/api/test/routes/trends.test.ts`. `pnpm -r typecheck` clean.
- **Milestone O — Company hiring timeline API (`GET /api/v1/companies/:slug/timeline`) + `hs companies timeline` CLI:** Time-bucketed hiring activity per company (new/closed/active jobs per window, role/location breakdowns, signal types per bucket) queryable by role category and date range with caller-selectable bucket widths (7/14/30 days, 90-day window cap). `getCompanyHiringTimeline` in `companies-repo.ts`; `companyTimelineQuerySchema` and `resolveTimelineWindow` in `packages/domain/src/company-timeline-query.ts` (pure, unit-tested). CLI side: `hs companies timeline <slug> [--since --until --roles --bucket-days]`.
- **Milestone N — Saved filter profiles (`apps/cli`):** `hs signals list --save` persists the given filter flags (role/company/q/locationMode/country/source/signalType/minScore/observedSince — not sort/cursor/limit) to a local config file (`~/.hiring-signals/config.json`, or `$XDG_CONFIG_HOME/hiring-signals/config.json` when set). Running `hs signals list` with no filter flags and a saved profile present applies it automatically, printing a one-line `Using saved filters: ...` note to stderr so the behavior stays visible rather than silent (stdout stays pure JSON). `hs signals list --clear-saved` removes it. Stores raw pre-parse flag strings rather than `signalsQuerySchema`'s parsed/defaulted output, so saved profiles never silently pick up `sort`/`limit`/`minScore` defaults for fields the user never touched; invalid or corrupt saved JSON is silently discarded on load via `signalsQuerySchema.safeParse`, no versioning, no re-save prompt. New `apps/cli/src/config-store.ts`. 22 new tests (`config-store.test.ts`, `signals-list-saved-filters.test.ts`, the latter real `bin/hs.mjs` subprocess spawns); manually verified end-to-end against a live local `wrangler dev` instance.
- **Milestone R — RSS feed (`GET /api/v1/feed.rss`) + `hs feed-url`:** Closes the "notify me later" gap — push-style delivery via any feed reader, no accounts, no new infrastructure. `lib/text/rss.ts` (R.1) is a dependency-free RSS 2.0 serializer (XML-escaped, RFC 822 dates, `<link>` omitted for company-level aggregate signals with no job-linked evidence). `apps/api/src/routes/feed.ts` (R.2) serves it at `GET /api/v1/feed.rss`, capped at `FEED_ROW_CAP = 50` items via a new `listSignalsForFeed` in `packages/db/src/signals-repo.ts`, with `ETag`/`Last-Modified`/`304 Not Modified` support and no KV caching. `hs feed-url` (R.3, `apps/cli`) prints the feed URL for a given filter set, reusing `signalsQuerySchema.omit(...)` and the same query-serialization helper the CLI's own HTTP calls use. 13 new tests (7 serializer, 6 CLI URL-building); manually verified end-to-end including the 304 conditional-request path.
- **Milestone F.1 — CLI (`apps/cli`), primary interface:** New `citty`-based workspace package, the primary interface now that `apps/web` is deleted. JSON-by-default on stdout, single-JSON-object machine-readable errors on stderr, no interactive prompts (admin actions require an explicit `--yes` instead). Thin client over `apps/api`'s existing routes only — no D1 access, no bypassing the API's own validation/rate-limiting/auth. Commands: `hs facets`, `hs signals list/get`, `hs companies list/get/timeline`, `hs sources list`, `hs trends hiring`, `hs feed-url`, `hs export signals [--out <path>]`, `hs admin source run/scheduler flush/reconcile`. `--format table` renderer added later (F.1 follow-up 2026-08-10) for list-style commands; detail commands and genuinely-nested shapes fall back to JSON with a one-line stderr note. `signalsQuerySchema` moved from `apps/api/src/routes/signals.ts` into `packages/domain/src/signals-query.ts` so the route and the CLI validate against the exact same schema. Tests: `test/api-client.test.ts` (14, mocked `fetch`) and `test/cli-process.test.ts` (5, real subprocess spawns asserting exit code and stderr shape). See `apps/cli/README.md` for exact invocations/output per command.
- **Milestone G.5 acceptance-criteria gaps closed (2026-08-10 → 2026-08-11):** `--format table` CLI output renderer for flat-list commands (§16.2); custom-career-site host injection fix in the `personio` adapter (§16.3.2, port-injection bug via `isValidCustomHost()` checking `url.host` instead of `url.hostname`); path-param schema validation for `GET /signals/:signalId` and `GET /companies/:slug`/`:slug/timeline` (§16.3.3 — new shared `signal-id-param.ts` / `company-slug-param.ts` schemas in `packages/domain/src`); API error-rate monitoring via Analytics Engine binding `API_METRICS` + `apps/api/src/middleware/api-metrics.ts` (§16.3.6, 12 tests in `api-metrics.test.ts` for route-shape normalization).
- **Milestone I.1 & I.2 — Semantic search write path (Vectorize index + Workers AI embedding write):** Provisioned `hiring-signals-jobs` Vectorize index (768-dim, cosine, `@cf/baai/bge-base-en-v1.5` matching) with metadata indexes on `companyId`/`roleCategory`/`locationMode`/`status`/`postedAt` (I.1). Jobs embedded (`buildJobEmbeddingText`) and upserted at ingest time, gated on new-or-content-changed jobs, try/catch so an embedding failure never fails the enclosing ingest message (I.2).
- **Milestone H — Signal-quality logic pass:** Real Volume/Acceleration/Breadth scoring (`score_version` v2, `packages/domain/src/signal-score.ts`), backed by a new `getCompanyRoleActivityStats` repo query (`packages/db/src/company-role-stats-repo.ts`). All four company-level signal types (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand`) now actually get created, not just typed. A description-channel classification-noise fix so an incidental phrase in a job description can no longer override a clean title+department match. A new daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`, `0 6 * * *` cron) recomputes stale active signals' scores without touching `last_detected_at`.
- **Milestone E — ATS Adapters (closed):** Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio — all via official documented APIs, each with fixture-driven tests covering malformed payloads and location-mode inference.
- **CSV Export Endpoint (`GET /api/v1/export/signals.csv`):** Full export API accepting all signal filter parameters. Returns RFC-4180 compliant CSV stream with a 2,000-row safety limit and `X-Export-Truncated` header. Backed by `exportSignals` in `packages/db/src/signals-export-repo.ts`. Also exposed as `hs export signals`.
- **Bulk Source Onboarding (`import-sources.mjs`):** Ops script for CSV-based batch company and source creation with pre-validation, duplicate skipping, and interactive confirmation.
- **Source management ops scripts (spec §10.5):** `infrastructure/scripts/add-source.mjs`, `update-source.mjs`, `add-company.mjs`, `update-company.mjs`, `source-health.mjs`, `ingestion-metrics.mjs`, `backfill-embeddings.mjs` (plus shared `lib/d1-exec.mjs` helper) — plain Node, shell out to `wrangler d1 execute --json` since a live `D1Database` binding only exists inside a Worker. Manual ingestion trigger is `update-source.mjs --run-now` (clears `next_poll_at`). `update-company.mjs` exposes `industry`/`employee-band`/`remote` tagging for companies.
- **`/api/v1/admin/*` (spec §10.5a):** Three secret-bearer-token-gated pipeline triggers (source-run, scheduler-flush, reconcile); source add/edit remains local-ops-script-only.
- **Milestone D — Write pipeline:** `apps/api/src/jobs/scheduler.ts` (cron finds due sources via `getDueSources`, enqueues one `IngestMessage` per source with deterministic per-source jitter, never fetches directly — spec §5.1/§5.2) and `apps/api/src/jobs/ingest-consumer.ts` (full fetch → validate → normalize → upsert → observe → lifecycle → classify → score → signal pipeline, idempotent per `(sourceId, runId)`, every §10.4 failure branch handled explicitly). Ingest pipeline fixed 2026-08-11 for the Cloudflare 1000-subrequest-per-invocation cap: `upsertJob` + `applyLifecycleTransition` combined into a single `client.batch()` call per job via `prepareJobUpsert`/`buildLifecycleStatement` pure statement builders, cutting per-job D1 calls from 3 to 2.
- **Ingest multi-chunk continuation (2026-08-13, Ashby/openai 700+ boards):** `processNormalizedJob` real worst-case cost ≈ 14 subrequests per new job (not ~2 — embed+Vectorize upsert + signal create + evidence append + company-signal triggers + activity-stats/active-signal reads all counted), so even the J.4 batch fix still hit the 1000-subrequest cap for full 700+ job boards. `apps/api/src/jobs/ingest-consumer.ts` now processes at most `JOBS_PER_CHUNK` jobs per invocation starting at `chunkOffset`, then re-enqueues a `continuation` IngestMessage for the remainder rather than processing the full board in one invocation. Continuation messages carry forward the original `sourceId`/`boardFetchMeta`/`runId` so dedupe/observations stay coherent across chunks. `JOBS_PER_CHUNK_OVERRIDE` env-seam added so tests can use tiny chunks without touching the production constant. Starts at 40 (40 × 14 ≈ 560, comfortable per-invocation headroom).
- **Scheduler in-flight guard (`hasRecentRunningRun`):** `packages/db/src/sources-repo.ts` new function returns true if a source has a `source_runs` row still `status='running'` and started within a freshness window. `handleScheduled` (`apps/api/src/jobs/scheduler.ts`) now skips enqueueing any due source with a recent in-flight run instead of stacking new runs on top. Window set to 45 minutes (well above one 15-min cron tick) so large-board multi-chunk runs are never mistaken for abandoned. 5 new live-D1 tests in `packages/db/test/sources-repo.test.ts`; 3 new in `apps/api/test/jobs/scheduler.test.ts`. `scheduler.test.ts`'s own cleanup fixed to delete `source_runs` before `sources` for FK safety.
- **Zero-Mocks Live Cloudflare Test Infrastructure (`packages/test-support`):** Remote transport layer, live D1 database client (`live-d1-client.ts`), and live KV/AI/Vectorize bindings (`live-cf-bindings.ts`) for end-to-end integration testing against real Cloudflare resources without mocks. Used by `packages/db` and `apps/api` suites per AGENTS.md's zero-mocks policy.

### Changed

- **License changed from MIT to Business Source License 1.1 (BSL-1.1) (2026-08-17):** `LICENSE` replaced with the full BSL 1.1 text (Licensor: Teycir Ben Soltane; Licensed Work: Hiring Signals Intelligence; Additional Use Grant: non-production use only; Change Date: 2030-08-17; Change License: Apache License 2.0). `project-metadata.json` `license` field updated from `MIT` to `BSL-1.1`; `llm.txt` License section updated to match. README's License section and BSL 1.1 badge were already correct and required no change.
- **README accuracy pass (2026-08-13):** Corrected stale claims across the Layout table, Tech Stack, Key Features, and Local dev sections: migration count updated from 0001-0004 to 0001-0009 (all 9 landed); `apps/api` description now lists company timeline route, trends route, RSS feed route, and API metrics middleware; CLI commands now include `hs companies timeline`, `hs feed-url`, and `hs trends hiring`; `lib/` description corrected (RSS serializer added to text utilities); ops scripts list now includes `update-company.mjs` and `ingestion-metrics.mjs`; semantic search status corrected from "write path only" to fully live (both write and query paths wired, Milestone I.3 complete); hiring velocity score surfaced in trends/companies descriptions.
- **Test organization:** All `*.test.ts` files moved from `src/` into sibling `test/` directories across all packages (apps/api, packages/adapters, packages/db, packages/domain). Import paths updated to relative `../src/*` references. Each package's tsconfig includes `test/**/*.ts` for typecheck coverage.
- **Error handling centralization:** `isUniqueConstraintError` helper moved from internal package location to `lib/d1/unique-constraint.ts`. All three call sites now import from single source. Deleted empty `packages/db/src/internal/` module.

### Security & Fixed

- **ENVIRONMENT var mislabel (apps/api/wrangler.toml top-level [vars]):** `ENVIRONMENT` was still `"development"` from initial scaffolding despite the top-level config being the actual production deploy target (no `[env.production]` block exists; only `[env.ci]`). Confirmed unused at runtime — the only reference is the Bindings type declaration, no route/middleware/job handler reads `env.ENVIRONMENT` — so it was a mislabel, not a functional bug. Corrected to `"production"` for hygiene ahead of any future code that branches on it.
- **Ingest consumer per-job subrequest cost was undercounted (JOBS_PER_CHUNK 150 → 40):** The J.4 2026-08-11 batch fix reduced upsert+lifecycle D1 calls from 3 to 2 per job, so `JOBS_PER_CHUNK` was initially set to 150 targeting a 2 × 150 = 300 D1-call budget. A full end-to-end walk of `processNormalizedJob` revealed real worst-case cost per *new* job is ~14 (observation insert + conditional embed + Vectorize upsert + classification update + activity-stats/active-signal reads + signal create + evidence append + company-level signal triggers in `generateCompanySignals`), meaning 150 × 14 ≈ 2,100 was well over Cloudflare's 1,000-service-subrequest-per-invocation free-plan cap. Lowered to 40 for 40 × 14 ≈ 560 of comfortable headroom. Combined with the multi-chunk continuation mechanism above (process 40, re-enqueue the rest), a 700+ job Ashby board now stays in budget per invocation.
- **Ingest chunk boundary now tracks real subrequest cost instead of a fixed job count (ROADMAP G.3 root cause, 2026-08-15):** `JOBS_PER_CHUNK=40` was sized against a single "~14 subrequests/job worst case" estimate that assumed every job in a chunk costs roughly the same. It doesn't — an unchanged existing job returns early after ~2 D1 calls, while a brand-new job pays the full ~14-call path (embed + Vectorize upsert, classification, activity-stats + active-signal reads, signal create/refresh, evidence append, company-level signal triggers). A 40-job chunk landing disproportionately on new jobs — exactly what an unpolled board like `openai`'s produces on its first run — could still exceed the real 1,000-subrequest-per-invocation cap mid-chunk, a kill below the JS layer with no thrown error. Fix: `SubrequestBudget` (`apps/api/src/jobs/ingest-consumer.ts`) counts the real number of Cloudflare-service calls issued this invocation (`chargeSubrequests`), threaded through `processNormalizedJob` and its callees. The chunk loop checks `budgetExhausted()` before each job and breaks once `SUBREQUEST_SAFETY_MARGIN=700` is reached, re-enqueuing the exact next unprocessed job as the next chunk's offset — self-correcting against real per-job cost variance instead of a static guess. `JOBS_PER_CHUNK=40` retained as a secondary hard backstop, no longer the primary boundary. 6 new pure-function tests (`apps/api/test/jobs/ingest-consumer-budget.test.ts`), runnable in CI unlike the live-D1 `ingest-consumer.test.ts` suite. `pnpm -r typecheck` clean across all 6 workspace packages, `apps/api` lint zero-warning clean. Committed `12ae111`, deployed 2026-08-16 (Worker version `d9960f2a-bb0c-4e67-a8c1-173496c466f1`).
- **G.3 first live confirmation + 69-row orphaned-run cleanup (2026-08-16):** The first `openai` cron tick after deploy (run `2dbb7ed4-44bd-40cc-921b-2fef7a544b13`, started 20:15:50Z) reached `status='success'` at 20:33:39Z with `jobs_normalized=746` — the first time in this incident's entire history an `openai` run has ever completed rather than dying silently at `running`/NULL. `markSourceSuccess` fired correctly (`last_success_at`/`next_poll_at` both populated, next poll ~6h out matching `poll_interval_minutes`). Also found and closed 69 pre-fix orphaned `status='running'` rows dating back to 2026-08-14 (hourly cadence — the existing `hasRecentRunningRun` 45-minute staleness guard correctly prevented sub-hour stacking, but every hourly retry still hit the underlying per-run kill this fix addresses, so none of those 69 runs had ever completed): closed via direct D1 write, `status='failed'`, `error_code='abandoned_run_cleanup'`, same pattern as the earlier 577-row incident. `recordSourceRunProgress`'s temporary diagnostic checkpoint deliberately NOT removed yet — its own stated removal bar is "a few real production runs," plural, and this is one data point; see ROADMAP.md G.3 follow-up for the remaining open item.
- **Temporary stuck-run diagnostic checkpoint (`recordSourceRunProgress`):** Multiple runs of the openai board died partway through a chunk with zero JS-catchable error and no `source_runs.error_code` populated — a platform-level kill bypasses the entire function's try/catch, leaving `jobs_normalized` permanently NULL. Added `packages/db/src/sources-repo.ts.recordSourceRunProgress(sourceRunId, jobsNormalized)` called every 10 jobs inside the chunk loop (writes only the counter column, never `status`/`completed_at`, so it never interferes with `recordSourceRunComplete`). Explicitly temporary: documented in both the function header and ROADMAP.md as a diagnostic aid to be removed once the actual per-chunk kill mechanism is confirmed via `wrangler tail` and `JOBS_PER_CHUNK` sized definitively.
- **Scheduler stacked concurrent runs indefinitely for any board that never completed (openai/Ashby):** `getDueSources` selects any source where `next_poll_at IS NULL OR next_poll_at <= now()`, and `next_poll_at` only advances via `markSourceSuccess` on a fully-successful final-chunk completion. Since openai's board never completed a run (whatever the per-chunk kill is, see above), `next_poll_at` stayed NULL forever, so **every 15-minute cron tick stacked a brand-new runId from `chunkOffset: 0`**. With `queue()`'s sequential `max_batch_size=10` handler, multiple runs' messages shared one invocation's CPU/subrequest budget, materially worsening the failure mode and making the per-chunk kill impossible to attribute cleanly. Peaked at **577 concurrent `status='running'` rows** (562 openai, 14 twilio, 1 leaked test fixture). Fix: `handleScheduled` now calls `hasRecentRunningRun(client, sourceId, now, staleAfterMinutes=45)` before enqueueing and skips any source still in flight — confirmed live on production Worker version `6f82cd4a` (deployed 2026-08-14): scheduler correctly logs `scheduler_skip_already_running`, concurrent-running count for openai held flat across 2 full ticks, and a single active run's `jobs_normalized` climbed 320→480 without contention.
- **Post-fix abandoned-run + test-fixture cleanup performed in production D1 (2026-08-14):** All 577 orphaned `status='running'` rows with `started_at` before the fix's deploy cutoff closed out via direct D1 write: `status='failed'`, `error_code='abandoned_run_cleanup'`, descriptive `error_message_safe`, computed `duration_ms`. Verified 0 rows remain before the cutoff while 2 genuinely-still-active runs (post-cutoff started_at) were left untouched. A separate pre-existing leak into shared production D1 was also found and removed FK-safe: a test-fixture company/source (`board_token: "test-ic-happy-src-2-*"`, `public_url: https://example.invalid/*`, slug `test-ic-happy-1-*`), owner of 1 of the 577 orphaned rows. Full cascade `signal_evidence → signals → job_observations → jobs → source_runs → sources → companies` deleted in FK-safe order; verified 0 residue. Worth a broader audit at some point for other `test-` / `example.invalid` residue, not done here.
- **Rate-limit Identifier Hashing (`lib/http/rate-limit.ts`):** Implemented `safeRateLimitIdentifier()` SHA-256 base64url hashing before key construction. Eliminates IPv6 colon separator injection and key boundary confusion that previously allowed counter bleeding across shards (security review 2026-07-30 HIGH 1 finding). Scrubs plaintext IP PII from KV keys.
- **Trusted-First Client IP Resolution (`apps/api/src/middleware/client-ip.ts`):** Security fix enforcing trusted IP extraction (`CF-Connecting-IP` > last hop of `X-Forwarded-For` > `"unknown"`). Prevents client spoofing of `X-Forwarded-For[0]` to bypass rate limits (security review 2026-07-30 HIGH 3 finding).
- **ATS adapter custom-host validation bug (personio.ts, spec §16.3.2):** The adapter's `isValidCustomHost()` guard checked `url.host` (port-inclusive) instead of `url.hostname` (port-free), allowing an explicit non-default port (e.g. `169.254.169.254:80`, the cloud metadata IP) to round-trip through unchanged. Fixed to require `url.port === ""`; added 5 targeted unit tests including the port-injection test that caught the bug.
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
