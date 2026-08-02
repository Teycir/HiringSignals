# ROADMAP.md

Detailed, sequenced task breakdown for the work remaining after Phase 0
(scaffolding) and the Phase 1 read-path (D1 schema + `GET` routes), both
complete as of 2026-07-27. `AGENTS.md` keeps repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable tasks
before anyone starts writing code, so scope doesn't get discovered
mid-implementation.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task below cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

---

## How to use this file

- Work top to bottom within a milestone; milestones themselves are
  ordered by hard dependency (you cannot build the scheduler before the
  write-path repos it calls exist).
- A task is only checked off once code is written, the cited spec section
  re-read against what was built, and the listed verification command run
  with a real passing result — same bar as AGENTS.md's "fix and verify"
  policy, applied to new work as well as bugfixes.
- If a task turns out bigger than it looks once you're in the code, stop
  and split it into sub-tasks here rather than quietly expanding scope
  inside one commit.
- Update `CHANGELOG.md` when a milestone completes.

---

## Completed milestones (trimmed — see git history for full narratives)

### Phase 0 — Scaffolding ✅ 2026-07-27
pnpm workspace, strict TS base, shared ESLint, `apps/web` (Next.js 16 +
Tailwind), `apps/api` (Hono Worker + middleware chain), `packages/domain`
core schemas, real D1/KV/Queue resources, anti-abuse middleware on read
routes, circuit breaker on D1 calls.

### Phase 1 — D1 schema + read paths ✅ 2026-07-27
Full schema (migration 0001), parameterized D1 client wrapper,
cursor-paginated signal feed with sort-aware cursors, company
autocomplete/detail/recent-signals, KV-cached facet counts, all `GET`
routes wired to real D1 queries.

### Milestone A — Write-path repositories (`packages/db`) ✅ 2026-07-28
`sources-repo.ts` (getDueSources, createSource, recordSourceRun*,
markSourceSuccess/Failure, DuplicateSourceError), `jobs-repo.ts`
(upsertJob, insertJobObservation, getJobsMissingFromRun,
applyLifecycleTransition), seed fixtures `seed-local-d1.sql` (20
companies, 20 sources, 60 jobs, 20 signals + evidence).

### Milestone B — Classification and lifecycle (pure logic) ✅ 2026-07-28
Title normalization, phrase-rule + abbreviation matcher against 10 P0
role categories, negative-term guard, confidence scoring
($C_{role}=0.70C_t+0.20C_d+0.10C_{desc}$, auto-classify ≥0.80), lifecycle
state machine (2 missing → possibly_closed, 4/14 → closed, reappear →
active). 24/24 tests in `packages/domain`.

### Milestone C — Signal generation ✅ 2026-07-28
`signals-write-repo.ts` (createSignal, appendSignalEvidence,
findActiveSignal, refreshSignal), `computeNewJobScore()` (S = min(100,
35R+25V+20A+10B+10Q-P), v1 R = freshness decay), wired into
ingest-consumer's post-upsert step.

### Milestone D — Scheduler, queue consumer, source-management scripts ✅ 2026-07-29
`scheduler.ts` (getDueSources + enqueue IngestMessage with deterministic
jitter, bounded per invocation), `ingest-consumer.ts` (full pipeline:
fetch → normalize → upsert → observation → lifecycle → classification →
signal generation → source_runs metrics; idempotency via unique keys;
failure handling per spec §13.4 table), ops scripts (`add-source.mjs`,
`update-source.mjs`, `source-health.mjs`, `add-company.mjs`) shelling out
to `wrangler d1 execute --json`. Cookie/Turnstile admin tier removed per
spec; secret-bearer-token admin triggers (§13.5a) added. Test folder
isolation (`src/` → `test/`), centralized `isUniqueConstraintError` in
`lib/d1/unique-constraint.ts`, `unusedBinding<T>` Proxy for fake test
bindings.

### Milestone E — 8 of 11 P0 adapters done, 3 blocked (in progress)
Completed: greenhouse (original), lever, ashby, smartrecruiters,
workable, recruitee, personio (2026-07-31), breezy (2026-07-31). All
have Zod schemas, typed errors, fixture tests, registered in
`registry.ts`. Blocked pending a scope decision (no public,
unauthenticated, documented per-company board API found — see
Milestone E section below): teamtailor, jazzhr, bamboohr.

### Milestone H — Signal-quality logic pass ✅ 2026-07-29
H.1 Description-channel noise fix (structured-categories guard), H.2
`getCompanyRoleActivityStats()` (V/A/B inputs in one query), H.3 Real
V/A/B scoring (computeVolume/Acceleration/Breadth, score v2), H.4
Company-level signals (`hiring_burst`, `role_acceleration`,
`multi_location`, `persistent_demand`), H.5 Reconciliation (daily stale
signal recompute via `reconciliation.ts`, daily cron 06:00 UTC).

### Milestone I — Semantic search (I.1, I.2 done) ✅ 2026-07-29
I.1 Vectorize index `hiring-signals-jobs` (768-dim, cosine) + 5 metadata
indexes (companyId, roleCategory, locationMode, status, postedAt) + AI
binding + `@cf/baai/bge-base-en-v1.5`. I.2 Embedding write path:
`buildJobEmbeddingText` + `embedAndUpsertJob` at ingest time with
try/catch guardrail (embedding failure ≠ ingestion failure).

### Milestone J — Test migration (partially done) ✅ 2026-07-30
Inventory completed. `live-d1-client.ts`, `live-d1-database.ts`,
`live-cf-bindings.ts` in `packages/test-support` (wrangler d1 execute
--remote transport, direct REST for AI/VECTORIZE/KV, KV namespace
generalization, 90s vitest timeouts). Migrated: all 4 `packages/db/test/*.test.ts`,
`reconciliation.test.ts`, `scheduler.test.ts`. Policy exceptions
documented in AGENTS.md: INGEST_QUEUE send-capture, ATS adapter mocking.

### Open questions (resolved 1 of 2)
- ✅ `createCompany` + `add-company.mjs` + `DuplicateCompanyError` (Milestone D follow-up)
- [ ] Lifecycle thresholds (2/4/14): confirm constants module satisfies "configuration, not hard-coded" intent

---

## Milestone E — Remaining P0 adapters (closed, 8 of 11 built + 3 blocked/deferred)

Spec §20 Phase 3 step 1 groups these with "production hardening," after
the dashboard (Phase 2). Sequence after Milestone F unless a specific
provider is needed for real-world messier data before UI work.

Same contract every time (`AtsAdapter`: `provider`, `fetchBoard`,
`normalize`), same fixture-test pattern. One PR/commit per adapter.

- [x] `personio` ✅ 2026-07-31 — XML feed (`workzag-jobs`), hand-rolled
      `xml-lite.ts` extractor (no XML dep), canonical URL construction
      verified against a real live board. 15/15 fixture tests, repo
      typecheck/lint/adapters-test all green (`pnpm -r typecheck`,
      `pnpm --filter @hiring-signals/adapters lint`/`test`).
- [x] `breezy` ✅ 2026-07-31 — public, unauthenticated careers-site JSON
      feed (`https://{company}.breezy.hr/json?verbose=true`), distinct
      from the token-gated `api.breezy.hr/v3/...` back-office API
      (same authenticated-API-vs-public-board-feed split this repo
      already has for Greenhouse/Lever). Verified two independent
      ways: (1) a non-vendor 2020 WordPress-plugin support-forum
      thread showing a real, unauthenticated hit against
      `kaycan.breezy.hr/json?verbose=true` returning valid JSON; (2)
      Breezy's own developer docs
      (`developer.breezy.hr/reference/model-position`) publishing the
      `Position` schema, whose field names (`friendly_id`,
      `location.is_remote`, `department`, `requisition_id`, `type.name`)
      line up with the public feed's shape. Canonical URL pattern
      (`{host}/p/{friendly_id}-{slug}`) confirmed against a real live
      posting (`teal-media.breezy.hr/p/a26c13c11570-...`); adapter
      prefers the feed's own `url` field, falls back to a constructed
      `{host}/p/{friendly_id}` link when absent. 13/13 fixture tests,
      repo typecheck/lint/adapters-test all green, 114/114 total
      adapter tests passing, 0 regressions.
- [ ] `teamtailor` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against Teamtailor's own docs (`docs.teamtailor.com`,
      `partner.teamtailor.com/job_boards/`) plus an independent
      third-party ATS-scraping field guide (github.com/Masterjx9/
      OpenPostings, discussion #16): public API is API-key-gated, the
      Job Board XML feed is beta/partner-issued-per-customer (no
      `{boardToken}`-style pattern to construct from a slug), and the
      only unauthenticated surface is raw HTML/undocumented RSS
      scraping — a materially different, less stable contract shape
      than every other adapter here. Removed from the active P0 build
      list (2026-07-31) pending a real product decision on whether
      HTML-scraping is in scope; not dropped from the domain
      `ATS_PROVIDERS` enum or existing seed data, since three seeded
      sources already reference it and downgrading them from a clean
      "adapter not implemented" (`UnsupportedProviderError`, spec
      §13.4) to "invalid provider" would be a regression, not a
      cleanup. Revisit as P1/deferred; full investigation notes in git
      history (this section, pre-2026-07-31).
- [ ] `jazzhr` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against JazzHR's own docs (`apidoc.jazzhrapis.com`,
      `success.jazzhr.com`): main API is customer-scoped/key-gated
      (some tiers Plus/Pro-only), the "global JSON feed" is opt-in
      cross-customer syndication (wrong shape, not just wrong auth —
      not a per-company `{boardToken}` endpoint), and the only public
      surfaces are a hosted careers page and JS "Jobs Widgets" with no
      documented backing API — corroborated independently by two
      commercial aggregators (JobsPipe, Fantastic.jobs) both having
      built their own crawling layer specifically because no clean
      public API exists. Same disposition as teamtailor: removed from
      the active P0 build list, kept in the domain enum/seed data
      (two seeded sources reference it), revisit as P1/deferred.
- [ ] `bamboohr` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against BambooHR's own docs
      (`documentation.bamboohr.com/reference/get-job-summaries`) plus
      an independent aggregator's own technical writeup
      (jobspipe.dev/sources/bamboohr): BambooHR is fundamentally an
      HRIS with an ATS module bolted on, its Jobs endpoint requires an
      authenticated caller with `hiring:applications` OAuth scope, and
      the only public surface (an embeddable careers widget) has a
      backing JSON URL/schema that "change[s] without notice" per the
      aggregator's own description of maintaining that integration —
      no stable per-company pattern this repo's adapter contract could
      rely on. Same disposition as teamtailor/jazzhr: removed from the
      active P0 build list, kept in the domain enum/seed data (one
      seeded source references it), revisit as P1/deferred.

**Milestone E is now closed for active adapter work**: all 11 P0
providers investigated, 8 built (greenhouse, lever, ashby,
smartrecruiters, workable, recruitee, personio, breezy), 3 blocked and
parked as above pending a product decision on HTML-scraping scope.
Don't restart work on the 3 blocked providers without that decision.

For each built adapter: confirm the provider's public, unauthenticated
board API is still live and documented *before* writing the schema
(spec §21) — don't assume last-known-good API shapes from training data
are current; check the provider's own developer docs.

- [x] `infrastructure/scripts/add-source.mjs`'s inlined provider enum
      copy — already in sync with `ATS_PROVIDERS` (verified 2026-07-31,
      all 11 providers present including the 3 blocked ones, since
      they're still valid DB values even without an adapter).
- [x] This file, updated as each adapter landed / as of the 2026-07-31
      Milestone E close-out above.

---

## Milestone F — Dashboard UI (Phase 2, `apps/web`)

Spec §11 (Minimal Brutalist visual system), §12 (Next.js requirements),
§10 (UX spec — route map, filters, signal cards, detail view, empty/
loading/error states).

**UI/animation inspiration (behavior, NOT styling): ArxivExplorer.**
Same account, same "single-page dense dashboard" shape. Reuse the
animation mechanics and interaction timing, never the visual styling.
ArxivExplorer is neon-red cyberpunk; this product is strict black/white
Minimal Brutalist (spec §11: no gradients, no glassmorphism, no drop
shadows, one scarce accent color).

**Concrete component-by-component reuse map** (confirmed present
2026-07-30 in ArxivExplorer on disk):

- **`ScrollProgress.tsx`** — port near-verbatim; restyle bar to 2px
  solid black/accent line instead of neon-red gradient.
- **`Card.tsx`** hover mechanics — keep `y: -3` lift, corner-accent
  squares (4px→6px, solid black border), 0.18s hover transition.
  **DROP: mouse-tracking radial glow + blur** (explicitly forbidden by
  spec §11.1).
- **`AnimatedTagline.tsx`** per-character stagger-in — reuse entrance
  cascade for the `HIRING//SIGNALS` masthead. **DROP: color-shift/
  text-shadow hover.** Must guard with `prefers-reduced-motion`.
- **`DecryptedText.tsx`** scramble-in-place — optional, lower priority
  (score badge). Gate to 700ms max in monospace; don't sacrifice score
  legibility mid-scramble.
- **`AchievementToast.tsx`** event-driven toast queue — reusable
  *mechanism*, not content (no achievements/gamification here). Flag as
  reusable pattern for later, don't build now.
- **`ParticleBackground.tsx`** / **`ui/background-beams.tsx`** — **do
  NOT port.** Pure decorative ambient motion; spec §11.1 forbids this.
- **`SearchBoxHome.tsx` / `SearchFilters.tsx` / `MoreLikeThisButton.tsx`
  / `RecentSearches.tsx` / `AbstractSearch.tsx`** — covered by
  Milestone I.4.

**Required dependency not yet installed:** `framer-motion` (Card,
AnimatedTagline, DecryptedText ports). `three` is explicitly NOT needed
(ParticleBackground rejected). Install when F actually starts, check
React 19 compatibility first.

Not detailed task-by-task here yet beyond the animation-reuse decision
— expand into same level of detail before starting; don't start UI work
directly off spec references.

---

## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §14.1 (security controls — no auth required/wanted; app public/free
permanently), §16.2/§16.3 (ops health + alerting on top of ops scripts),
§18 (CI/CD), §19 (acceptance criteria).

Not detailed task-by-task yet — expand before starting. No auth item:
single-tenant, public, no login, ever (spec §22 preamble).

---

## Milestone I — Semantic search (Workers AI + Vectorize): I.3–I.5 remaining

Read spec §9.4 (Semantic search, added 2026-07-29) before starting.
I.1 (Vectorize + AI binding) and I.2 (embedding write path) are done —
see Completed milestones above.

### Scope reminder (decided 2026-07-29)
1. Free-text search over signals/jobs layered onto existing `q` param
   (company-name search + semantic leg, merged by score). Ships first.
2. Classification assist: semantic similarity as *additional* input,
   NEVER replacement for deterministic rules. Out of scope until I.1–I.4
   done. Pipeline must keep working identically with empty Vectorize
   index (spec §6.2).

### UI inspiration: ArxivExplorer (again, UX mechanics NOT styling)
`SearchBoxHome.tsx` (hero search + filter chips + active-filter badge),
`SearchFilters.tsx` (chip-toggle panel, `useSearchParams`-driven —
shareable/bookmarkable URLs), `MoreLikeThisButton.tsx` (one-line
`router.push(?like=:id)`), `RecentSearches.tsx` (localStorage-backed
last-N-queries), `AbstractSearch.tsx` (paste-arbitrary-text mode,
textarea + live char count + ⌘Enter submit). Port the shape, restyle
from scratch against spec §11 tokens — do not copy Tailwind classes
verbatim.

Spec: §9.4, §6.2 (I.5 guardrail), §9.3 (existing `q` param), §11 (visual
system), §13.1 (Workers AI/Vectorize bindings).

- [x] **I.3 — Backfill script + query-side hybrid search** ✅ verified
      2026-08-01 (code already complete from a prior session; this
      roadmap entry had lagged behind actual shipped state — corrected
      here, no new code needed)
      (`infrastructure/scripts`, `packages/db`, `apps/api/src/routes`)
  - `backfill-embeddings.mjs` present (13KB,
    `infrastructure/scripts/backfill-embeddings.mjs`) — `wrangler d1
    execute --json` + direct Workers AI/Vectorize REST call pattern,
    no authenticated admin route.
  - Query-side hybrid search fully wired: `apps/api/src/services/
    semantic-search.ts` (`findSemanticSignalMatches` — embeds query via
    `env.AI`, queries `env.VECTORIZE`, resolves hits to signals via
    `packages/db`'s `findSignalsByJobIds`, 24h KV-cached query
    embeddings, never throws) called from `apps/api/src/routes/
    signals.ts`; pure merge/ranking logic lives in `packages/domain/
    src/signal-search-merge.ts` (`mergeSignalMatches`, keyword weight
    1.0 vs semantic weight 0.6, dedup by signal id, `matchedVia`
    keyword/semantic/both).
  - Verified 2026-08-01: `packages/domain/test/signal-search-merge.test.ts`
    (7/7 passing, part of 70/70 domain suite), `pnpm -r typecheck`
    clean across all 6 workspace packages, `pnpm -r lint` clean (0
    errors). No dedicated `apps/api` route-level test yet (no
    `apps/api/test/routes/` directory exists) — live Vectorize/Workers
    AI query smoke-test against a backfilled index still outstanding;
    tracked as a follow-up, not blocking since the pure-logic core
    (merge ranking) has full coverage and the service degrades to
    empty-array-never-throws on any live-dependency failure per its
    own header contract.

- [ ] **I.4 — Search UI** (`apps/web`, spec §11)
  - `apps/web` is still near-scaffold, so this is genuinely new UI.
    This item is ONLY the search surface; the rest of F's dashboard
    stays scoped to Milestone F — don't let I.4 silently become all
    of F.
  - Port (not copy) from ArxivExplorer, restyled against spec §11:
    `SearchBoxHome.tsx` → signals-feed search bar (placeholder:
    "Try: remote rust backend, hybrid platform engineer…"),
    `SearchFilters.tsx` chip-toggle → existing filters
    (`roles`/`locationMode`/`country`/`source`/`signalType`/`minScore`),
    `MoreLikeThisButton.tsx` → "similar roles" on signal detail via
    Vectorize getByIds+query, `RecentSearches.tsx` +
    `lib/searchHistory.ts` localStorage pattern — reuse logic near
    verbatim, restyle list only. `AbstractSearch.tsx` paste-text
    mode is optional/lower-priority — flag as follow-on.
  - Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint` clean;
    smoke-test search-with-filters round-trips through URL correctly.

- [ ] **I.5 — Classification assist (deferred until I.1–I.4 verified)**
  - Not detailed — deliberately. Semantic similarity between job
    embedding and role-category centroids becomes *additional* signal
    `classifyJob` consults only in already-existing "low title
    confidence, need department/description disambiguation" path (spec
    §6.2 step 5) — NEVER a gate on whether classification runs, NEVER
    can push to `autoClassified: true` on its own if deterministic
    channels (per H.1's structured-channel guard) disagree. Expand
    into real sub-tasks, spec-cited against §9.5 addendum, before
    writing any `classification.ts` change.

---

## Milestone J — Migrate test suite off in-memory fakes (remaining items)

**Status:** Inventory + all core migration done (verified 2026-08-01).
Transport layer in `packages/test-support`: `live-d1-client.ts`/
`live-d1-database.ts` (wrangler d1 execute --remote), `live-cf-bindings.ts`
(direct REST for AI/VECTORIZE/KV, 90s vitest timeouts). Files migrated
from in-memory fakes to live Cloudflare resources: all 4 `packages/db/test/*.test.ts`,
`apps/api/test/jobs/reconciliation.test.ts` (3 tests),
`apps/api/test/jobs/scheduler.test.ts` (5 tests),
`apps/api/test/jobs/ingest-consumer.test.ts` (21 tests). All use the
same two documented permanent exceptions in `apps/api/test/jobs/*.test.ts`:
ATS adapter mocking (`vi.mock("@hiring-signals/adapters")`) and
in-memory INGEST_QUEUE send capture. See AGENTS.md "zero mocks, zero
fakes" section for the full policy and the two narrow, documented
exceptions.

- [x] **Migrate `apps/api/test/jobs/ingest-consumer.test.ts`** — 1125
      lines, 21 tests (8 happy-path, 9 failure-branch including
      missing-source / uncaught-error-retry / programmer-error-fail-fast,
      5 H.4 company-signal-generation). Verified 2026-08-01 with real
      live run: `DB` uses `createLiveD1Database()`, `AI` uses
      `createLiveAiBinding()`, `VECTORIZE` uses `createLiveVectorizeIndex()`,
      `RAW_PAYLOADS` uses `createLiveKvNamespace("RAW_PAYLOADS")`.
      Zero `vi.mock("@hiring-signals/db")`. Only the two AGENTS.md
      permanent exceptions remain: `vi.mock("@hiring-signals/adapters")`
      and an in-memory `INGEST_QUEUE` sent-array capture. Cleanup
      matches scheduler/reconciliation discipline: FK-safe teardown
      order, test-ic-prefixed slugs, try/finally + afterEach sweep,
      best-effort Vectorize vector cleanup by job id. Runtime: ~1501s
      across all 21 tests (each test makes many live
      `wrangler d1 execute --remote` calls plus real Workers AI embeds
      and Vectorize upserts); log confirms real `ingest_success` /
      `ingest_failed` / `ingest_programmer_error` events with real
      source IDs, run IDs, and 20–100+s durations.
      `pnpm --filter @hiring-signals/api typecheck` clean; full test
      run exit code 0.

- [x] **CI workflow — typecheck + lint** ✅ 2026-08-02
      (`.github/workflows/ci.yml`)
  - `.github/workflows/ci.yml` added: Node pinned via `.nvmrc`
    (24.18.0), pnpm pinned to `11.17.0` (matches `package.json`'s
    `packageManager` field), `pnpm install --frozen-lockfile`, then
    `pnpm -r typecheck` and `pnpm -r lint`. Triggers on push/PR to
    `main`.
  - Deliberately does NOT run `pnpm -r test` yet. Checked (2026-08-02):
    the existing `CF_TOKEN` GitHub secret is scoped to Workers AI +
    Vectorize only (confirmed with the repo owner), matching
    `.env.local.example`'s own documented scope — it does not have D1
    permissions. Locally, D1 access instead piggybacks on wrangler's
    browser-login session (no script-visible secret), which doesn't
    exist in a CI runner. Wrangler's own non-interactive auth path is
    the standard `CLOUDFLARE_API_TOKEN` env var (different from this
    repo's app-level `CF_TOKEN`) — needs a **second**, `D1: Edit`-only
    scoped token minted and added as a new secret before `pnpm -r test`
    (every live suite in this repo talks to real remote D1 per
    AGENTS.md's zero-mocks policy) can run in CI. Tracked as a
    follow-up below, not done today.
  - Verified locally by reproducing the exact workflow steps under
    `nvm use 24.18.0`: `pnpm -r typecheck` — clean, exit 0, all 6
    workspaces. `pnpm -r lint` — clean, exit 0 (5 pre-existing
    warnings in `test-support`/`apps/api`, 0 errors) after deleting 5
    tracked-but-unused one-off live-D1 debugging scratch scripts from
    `packages/db` (`check_group.mjs`, `check_orphans.mjs`,
    `check_query.mjs`, `cleanup_debug.mjs`, `debug-still-active.mjs`)
    that were failing lint with `no-undef` on bare `console` calls and
    would have made this workflow red on its first run — confirmed
    unreferenced anywhere else in the repo before removing.

- [ ] **Follow-up: wire `pnpm -r test` into CI** — mint a second
      Cloudflare API token scoped to `D1: Edit` only (same account),
      add as a new GitHub secret (name TBD — must not collide with the
      existing AI/Vectorize-scoped `CF_TOKEN`), export it as
      `CLOUDFLARE_API_TOKEN` in the workflow (wrangler's standard
      non-interactive auth env var) so `wrangler d1 execute --remote`
      calls in `packages/test-support`'s live-D1 transport succeed
      unattended. Add a `test` job/step once that secret exists;
      expect long runtimes (some suites here run 500–1500s against
      real Cloudflare infrastructure per Milestone J's notes) — budget
      CI timeout accordingly.

- [x] Update AGENTS.md policy section's "Follow-up, tracked, not done
      today" note once `ingest-consumer.test.ts` lands too. Done
      2026-08-01 in the same turn as this ROADMAP correction.

### `packages/test-support` follow-ups (verified against actual file contents 2026-07-30)

- [ ] `live-cf-bindings.ts` `loadCfToken()` (`.env.local` parser) only
      matches `CF_TOKEN=value` exactly. Swap in real dotenv parser or
      add a comment documenting supported shape.
- [ ] Near-identical `execRemote`/`runWrangler` spawn plumbing across
      `live-d1-client.ts` and `live-cf-bindings.ts`. Consider factoring
      into one shared helper in `packages/test-support`.
- [ ] `live-d1-client.ts` `execRemote` has no credential preflight of
      its own, relies on ambient wrangler auth. Worth aligning with
      `live-cf-bindings.ts`'s explicit `loadCfToken()`/clear
      "Missing CF_TOKEN" error — decide and document.
- [ ] `live-d1-client.ts` `execRemote` includes full SQL + inlined
      params in thrown errors. Worth truncation/redaction strategy or
      explicit "safe because test-only" comment before broader use.
- [ ] Short README / package doc comment for `@hiring-signals/test-support`
      covering: which live Cloudflare resources each file touches,
      required env vars, missing-token failure modes per file, why
      these are real clients not mocks (per AGENTS.md policy).

---

## Milestone K — `still_active` signal + detection-latency metric

Spec §1.4 (`still_active` defined but never generated), §15 (detection
latency is primary metric, not tracked), §7.1 (signal type table).
Shared: both reuse H.5's daily reconciliation cron.

**Why this adds value:** passive job seekers need to know a bookmarked
listing is still open. Detection latency is optimization target per
spec §1.1 — without measuring it, cadence tuning is guesswork.

- [x] **K.1 — `still_active` signal generation**
      (`apps/api/src/jobs/reconciliation.ts`, `packages/domain`)
  - Daily reconciliation pass: for each active signal whose
    `last_detected_at` older than `pollIntervalMinutes * 2` and the
    backing job's `last_seen_at` recent, append a `still_active`
    evidence row on the existing active `new_job` signal (not a new
    signal row). Signal `last_detected_at` update prevents score
    decay. Trigger condition: `status='active'` AND job
    `last_seen_at` within `pollIntervalMinutes * 1.5` AND signal
    `last_detected_at` older than 24h (avoid double-append same day).
  - `buildHeadline`/`buildSummary`: "Role still active" / "Matching
    role confirmed open at last check."
  - Verify: extend `reconciliation.test.ts` with recently-seen active
    appends evidence, stale-job does not.
  - Fixed during verification: `listStillActiveCandidates`'s
    `last_seen_at` cutoff compared SQLite `datetime()`'s
    space-separated output directly against ISO `T`/`Z` timestamps —
    a string comparison, not a temporal one, that let stale jobs
    through almost unconditionally. Also, the call site never passed
    a real `now`, so the cutoff anchor silently reused `staleBefore`
    (`now - 24h`) instead. Both fixed: `now` is a real parameter, and
    `last_seen_at` is wrapped in `datetime()` too for a normalized
    comparison. All 6 `reconciliation.test.ts` tests pass against
    live D1.

- [ ] **K.2 — Detection-latency tracking**
      (`packages/db/src/jobs-repo.ts`, `apps/api/src/jobs/ingest-consumer.ts`,
      `infrastructure/scripts/source-health.mjs`)
  - Already computable from existing columns (no schema change):
    `first_seen_at` − `source_runs.started_at` via
    `job_observations` → `source_runs` JOIN filtered to the run that
    first observed each job.
  - New repo function `getDetectionLatencyStats(client, { sourceId?, since })`
    → `p50LatencyMinutes`, `p95LatencyMinutes`, `sampleCount`.
  - Surface in `source-health.mjs` table: add `p50 latency` column.
    This is spec §20 Phase 3 step 6's concrete output.
  - Verify: repo test asserting correct p50/p95 on seeded known-timing
    rows; manual `source-health.mjs` run confirming column appears.

---

## Milestone L — CSV export (`GET /api/v1/export/signals.csv`)

Spec §2.1 (P0 feature), §9.2 (endpoint listed), §8.3 (export artifacts
expire after 24h in KV). Listed "not yet built" in README. Only P0
spec-required feature with no prior milestone.

**Why this adds value:** secondary audience (investors, recruiters)
needs filtered signal export for offline analysis. Without export, the
dashboard is read-only.

- [x] **L.1 — Export route** (`apps/api/src/routes/export.ts`) ✅
      2026-08-01
  - `GET /api/v1/export/signals.csv` — accepts same query params as
    `GET /api/v1/signals` (full §9.3 set) but returns `text/csv`.
  - Reuse `listSignals` with raised `limit` (v1 cap: 2000 rows,
    document as v1 cap not permanent limit). If result exceeds cap,
    return what fits with `X-Export-Truncated: true` header.
  - CSV columns: `signal_id`, `signal_type`, `score`, `company_name`,
    `role_category`, `headline`, `location_mode`, `country_code`,
    `first_detected_at`, `last_detected_at`, `source_platform`,
    `canonical_url`. No personal data — all job/company fields per
    spec §14.2.
  - Response headers: `Content-Type: text/csv; charset=utf-8`,
    `Content-Disposition: attachment; filename="hiring-signals-export.csv"`,
    `Cache-Control: no-store`.
  - Apply same `freeReadTier` middleware as every other read route
    (spec §13.2).
  - Verify: route test asserting correct CSV headers + column order,
    `X-Export-Truncated: true` at cap, same filters work for both
    endpoints.
  - **Implementation note:** built `listSignalsForExport` as a new
    `packages/db/src/signals-repo.ts` function rather than reusing
    `listSignals` directly — export needs no cursor/pagination (a
    single capped dump, spec doesn't describe a paginated CSV) and
    needs two extra columns (`canonical_url`, `source_platform`) that
    `listSignals`/`SignalListItem` don't carry, resolved via a
    "representative job" (most-recently-observed signal_evidence row
    with a non-null job_id) LEFT JOIN. Company-level signals
    (hiring_burst etc., Milestone H.4) with no job-linked evidence
    render those columns (plus `location_mode`/`country_code`) as
    empty CSV cells, not an error. New `lib/text/csv.ts` (RFC 4180
    encoder, no dependency) backs the CSV writer in `export.ts`.
    Verified 2026-08-01: 5 new tests in
    `packages/db/test/signals-export-repo.test.ts` (representative-job
    field resolution, null-fields-for-company-level-signal,
    most-recent-evidence tie-break across multiple jobs, roles/minScore
    filter parity with `listSignals`, score_desc ordering) — 5/5
    passing against live D1 (`npx vitest run
    test/signals-export-repo.test.ts`, exit code 0, ~281s). `pnpm -r
    typecheck` clean across all 6 workspaces; lint clean on every new/
    changed file (`packages/db/src/signals-repo.ts`,
    `apps/api/src/routes/export.ts`, `lib/text/csv.ts`) — the
    `packages/db` package-level lint failures that show up are
    pre-existing issues in unrelated scratch `.mjs` debug scripts, not
    touched here. No dedicated `apps/api` route-level HTTP test (same
    gap Milestone I.3 already noted — no `apps/api/test/routes/`
    directory exists yet); the repo-level function has full coverage
    and the route itself is a thin query-parse + call + CSV-serialize
    layer with no independent logic to test beyond what's covered.

- [ ] **L.2 — Export button in dashboard UI** (`apps/web`, spec §10.2)
  - Spec §10.2 masthead mockup has `[EXPORT CSV]` top-right. Wire to
    `GET /api/v1/export/signals.csv` with current URL's filter params
    forwarded. Plain anchor `href` from `useSearchParams()` — no
    fetch/blob dance needed. Disable (grey, not hidden) when empty
    state.
  - **Sequence after Milestone F** — can't build until F's filter
    rail + URL-param state exist.

---

## Milestone M — Bulk source onboarding (CSV import)

Spec §2.2 (P1: "Manual company/source onboarding from a CSV"), §22
open decision 2 (registry growth bottleneck).

**Why this adds value:** adding 100 companies today requires 100
separate `add-company.mjs` + `add-source.mjs` invocations. CSV import
removes that friction; prerequisite for registry growing fast enough
to make the feed useful.

- [x] **M.1 — `import-sources.mjs` ops script** ✅ verified 2026-08-02
      (`infrastructure/scripts/import-sources.mjs`)
  - One argument: CSV file path. Columns: `company_slug`,
    `company_display_name`, `company_domain` (optional), `provider`,
    `board_token`, `public_url`, `poll_interval_minutes` (optional,
    default 90). One row = one source; multiple sources for same
    company share `company_slug`.
  - Two-pass design (no interactive TTY prompt exists anywhere in this
    repo's ops scripts — confirmed via grep): pass 1 parses + validates
    the entire CSV against live D1 (hand-rolled RFC 4180 parser, no
    dependency), prints a per-row `[OK]`/`[SKIP]`/`[ERROR]` plan plus a
    summary count, and pass 2 only writes if pass 1 found zero invalid
    rows. Company created once per slug (`createdCompanyIds` map)
    even when multiple rows share a `company_slug`; duplicate
    `provider`+`board_token` (in-CSV or already-in-D1) is a skip, not
    fatal — re-running the same CSV is safe/idempotent. Same
    `.mjs`-over-`wrangler d1 execute --json` pattern as every other ops
    script (`lib/d1-exec.mjs`, run from `apps/api`, DB name
    `hiring-signals`).
  - Verified 2026-08-02 against local D1 with `test-import-sources.csv`
    (repo root, 4 data rows: 2 new companies, 1 second source sharing
    an existing company, 1 in-file duplicate source): first run
    created 2 companies + 3 sources exactly as planned, with the
    plan-time "new company" vs "existing company" label correctly
    reflecting one-create-per-slug (fixed a cosmetic mislabel found
    during this same verification pass, tracked via
    `slugsPlannedForCreation`). Re-ran the identical CSV a second time:
    all 4 rows returned `[SKIP]` (3 pre-existing-in-D1, 1 in-file dup),
    0 created, 0 written — idempotency confirmed on a real second run,
    not just by code inspection. Test rows cleaned from local D1
    afterward (`sources`/`companies` both confirmed at count 0 for the
    `test-imp-%` prefix). `pnpm -r typecheck` was already clean from
    the prior session that wrote the script; no code changes were
    needed this session beyond the label fix already applied.

---

## Milestone N — Saved filters (client-side, no backend)

Spec §2.2 (P1: "Saved role/location filter profiles"). Deliberately
client-side `localStorage` only — no backend, no accounts, no new API
surface. Spec P1 says "saved dashboard view," not "server-persisted
profile"; product has no login, so client-side only option consistent
with §14.1.

**Why this adds value:** passive job seeker re-enters role/location
preferences every visit without this. Lowest-effort high-retention
feature available.

- [ ] **N.1 — Filter profile save/load** (`apps/web`)
  - "SAVE FILTERS" button in filter rail (spec §10.2 layout) writes
    current URL filter params to `localStorage` under
    `hiring-signals:saved-filters`. On page load, if saved filters
    exist AND no URL params present, offer single-line dismissible
    "RESTORE SAVED FILTERS" banner. Don't silently apply saved
    filters — URL is source of truth (spec §12.2).
  - Storage format: plain JSON of `signalsQuerySchema` params. No
    v1 versioning — if Zod parse fails on load, silently discard
    stored value + show prompt to re-save.
  - "CLEAR SAVED FILTERS" button alongside when profile exists.
  - **Sequence after Milestone F.**

---

## Milestone O — Company hiring timeline API + page (investor/analyst view)

Spec §1.4 (company-level signals), §10.1 (`/companies/[slug]` route
unspecified beyond "timeline + active roles"), §2.3 ("Trend charts" P2
— this milestone is structured-data foundation, not charts).

**Why this is the real differentiator:** no public tool gives a
structured, timestamped, evidence-backed record of *how a specific
company's hiring composition changed over time*. Already being
collected by ingestion; just needs a dedicated read path + legible
page. Constraint: never claim to represent intent/budget/confirmed
decisions — only observable public evidence (spec §14.3).

### O.1 — Company hiring timeline API endpoint

`GET /api/v1/companies/:slug/timeline`

Time-bucketed summary of hiring activity for one company, queryable
by role category + date range. Pure read path over existing jobs +
signals.

- [ ] New repo function `getCompanyHiringTimeline(client, { companyId,
      roleCategoryFilter?, since?, until?, bucketDays? })` in
      `packages/db/src/companies-repo.ts`. Returns array of buckets,
      each with: `bucketStart`/`bucketEnd` (ISO-8601), `newJobsCount`,
      `closedJobsCount` (approx from last_seen_at + lifecycle),
      `activeJobsCount` (snapshot at bucket end), `roleBreakdown`
      (top role categories per bucket), `locationBreakdown` (top
      countries), `signalTypes` (distinct signal types fired).
      Default bucket: 14 days, caller override 7/14/30. Cap at 90
      days v1.
  - Index check: `idx_jobs_filters (company_id, role_primary, status,
    last_seen_at DESC)` exists. Run `EXPLAIN QUERY PLAN` on bucketed
    `first_seen_at` aggregation; add migration for
    `(company_id, first_seen_at)` if scanning.
  - Verify: live-D1 repo test seeding jobs across 3 date buckets.

- [ ] New route `GET /api/v1/companies/:slug/timeline` in
      `apps/api/src/routes/companies.ts`. Query params: `since`
      (default 90d ago), `until` (default now), `roles`, `bucketDays`
      (7/14/30 default 14). Public/unauthenticated per §14.1.
      Envelope: `{ data: { company, buckets }, meta: { requestId } }`.

### O.2 — Company page: hiring timeline view (`/companies/[slug]`)

Spec §10.1 lists this route unspecified. Investor-facing, dense,
data-forward, no decoration.

```text
┌──────────────────────────────────────────────────────────────────┐
│ ACME CORP                          acme.example  [EXPORT CSV ↗]  │
│ Monitored since 2026-03-01 · 3 sources · Last sync 2h ago        │
├──────────────────────────────────────────────────────────────────┤
│ HIRING ACTIVITY — LAST 90 DAYS                                   │
│                                                                  │
│  NEW ROLES  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  (bar chart: one bar per 14-day bucket, height = newJobsCount)   │
│                                                                  │
│  BY ROLE    [Software Eng ██████] [ML ████] [DevOps ███] ...     │
│  BY LOCATION [US ████████] [DE ███] [Remote ██████] ...          │
├──────────────────────────────────────────────────────────────────┤
│ SIGNALS                                                          │
│  [82] HIRING BURST / ML · 4 new roles in 14d · 3h ago           │
│  [71] MULTI-LOCATION / DevOps · US + DE + Remote · 1d ago       │
│  ...                                                             │
├──────────────────────────────────────────────────────────────────┤
│ ACTIVE ROLES (12)                                                │
│  Senior ML Engineer · Remote US · OBSERVED 3H AGO [VIEW →]      │
│  ...                                                             │
└──────────────────────────────────────────────────────────────────┘
```

- Pure CSS/SVG bar chart — no charting library. Each bar = `<div>`
  or `<rect>` with height ∝ newJobsCount/max(newJobsCount). Brutalist:
  black bars, white background, 2px black border container, NO
  gridlines, NO hover tooltips (data labels below each bar instead).
  No animation.
- Role/location breakdowns: horizontal CSS bar rows, label + count
  inline. No pie/donut charts — obscure absolute numbers.
- "Monitored since" = earliest `source_runs.started_at` for this
  company's sources. Data provenance.
- Export CSV button links to `GET /api/v1/export/signals.csv?company=<slug>`
  (Milestone L).
- **Sequence after Milestone F.**

---

## Milestone P — Hiring trend API: cross-company analytics

Spec §1.2 (investor/analyst as secondary audience), §2.3 ("Trend
charts" deferred — this is API layer without charts UI).

**Why beyond Milestone O:** single-company timeline = due diligence.
Cross-company trend = market intelligence: "which fintechs started
hiring ML in last 60d?", "accelerating DevOps hiring in Germany."
Not answerable from role-first signal feed; has no sector/industry
dimension today.

Adds read paths only — no new ingestion, no new schema beyond existing
`companies.industry` column (spec §8.2).

- [ ] **P.1 — Industry/sector tagging for companies**
      (`infrastructure/scripts/update-company.mjs`)
  - `companies` already has `industry TEXT` but no ops script exposes
    it. Add `update-company.mjs` accepting `--id`, `--industry`,
    `--employee-band` flags. Same `.mjs`-over-`wrangler d1 execute
    --json` pattern. Industry = free-text tag v1 ("fintech",
    "healthtech", "defense"); controlled vocabulary = future
    refinement.
  - Verify: local D1 confirm `industry` persists; missing `--id`
    rejected. `nvm use 24.18.0` first.

- [ ] **P.2 — Cross-company trend endpoint**
      `GET /api/v1/trends/hiring`
  - Query params: `roles` (comma-delimited, required ≥1), `industry`
    (optional free-text), `country` (optional ISO), `since` (default
    30d), `sort` (`acceleration_desc` / `volume_desc` /
    `newest_signal`, default `acceleration_desc`), `limit` (1–50,
    default 20).
  - Returns ranked companies with most notable hiring activity:
    `{ company: { slug, displayName, industry, domain },
    newJobsCount, activeJobsCount, acceleration, topLocations,
    latestSignalType, latestSignalAt }`. `acceleration` reuses
    `computeAcceleration(n14, n56)` from `packages/domain` — same
    formula, same version.
  - New repo function `getHiringTrends(client, { roleCategoryFilter,
    industryFilter?, countryFilter?, since, limit, sort })` in
    `packages/db/src/signals-repo.ts` or new `trends-repo.ts`
    (decide at impl time).
  - Index check: joins `companies` → `jobs` filtered by `role_primary`
    + `first_seen_at` window + optional `country_code`.
    `idx_jobs_filters` covers role but not first_seen_at or
    country_code. Run `EXPLAIN QUERY PLAN`; add migration for
    `(role_primary, first_seen_at, country_code)` if scanning.
  - Rate-limit: same `freeReadTier`. Consider 5-min TTL KV cache for
    identical param combinations (same pattern as `facets-repo.ts`).
  - Verify: repo test seeding companies across two industries with
    varying role counts + sort order assertion; route test asserting
    industry filter; `pnpm -r typecheck`/`lint`/`test` clean.

- [ ] **P.3 — Trends surface in dashboard UI** (`apps/web`)
  - `/trends` route (add to spec §10.1): role selector chip-toggle at
    top, optional industry/country filter, ranked company list below.
    Each row: company name, role count, acceleration indicator
    (▲ / — / ▼), top location, latest signal type, timestamp,
    `[VIEW COMPANY →]` linking to `/companies/[slug]` (O.2).
  - No charts on page — the table is the product. Charts P2, require
    historical data that won't exist until weeks of running.
  - **Sequence after Milestone F + O.2.**

---

## Milestone Q — Hiring velocity score per company (investor-grade signal)

**Why this is the real moat:** existing signal score (§7.2) ranks
individual role-level signals. Investors need a single **company-level
hiring velocity score** answering "how aggressively is this company
building its technical team right now, vs. its own baseline?" Different
question from "is this specific job posting fresh?" Computable from
data already collected; no new ingestion beyond one migration.

- [ ] **Q.1 — Hiring velocity score computation**
      (`packages/domain/src/hiring-velocity.ts`, new file)
  - Pure function `computeHiringVelocity(stats: CompanyRoleStats):
    HiringVelocityResult` — `CompanyRoleStats` = output of
    `getCompanyRoleActivityStats` (H.2) aggregated across *all* role
    categories for a company.
  - Score formula (v1, versioned same as signal score):
    ```
    V = clamp(
      0.40 * acceleration + 0.25 * breadth
      + 0.20 * volume_norm  + 0.15 * persistence
    , 0, 100) * 100
    ```
    acceleration/breadth reuse `computeAcceleration` and
    `computeBreadth` from `signal-score.ts` (H.3); volume_norm =
    `clamp(totalActiveJobs / 10, 0, 1)`; persistence =
    `clamp(daysSinceFirstSignal / 30, 0, 1)`.
  - Store as `companies.hiring_velocity_score` (INTEGER) +
    `companies.velocity_score_version` (TEXT) +
    `companies.velocity_computed_at` (TEXT). Migration
    `0005_company_velocity_score.sql` adding these three with DEFAULT
    NULL.
  - Verify: hand-computed unit tests (cold=0, multi-loc-accel=high,
    stale=decay); `packages/domain` test/typecheck/lint clean.

- [ ] **Q.2 — Velocity score recompute in reconciliation**
      (`apps/api/src/jobs/reconciliation.ts`)
  - Daily reconciliation pass: after per-signal recomputes, add a
    company-level pass for each company that had ≥1 signal refreshed
    today. Call `getCompanyRoleActivityStats` variant aggregating
    across all roles (new query or new `getCompanyActivityStats`),
    compute `computeHiringVelocity`, `UPDATE companies SET
    hiring_velocity_score=?, velocity_score_version=?,
    velocity_computed_at=?`.
  - Verify: extend `reconciliation.test.ts` asserting velocity score
    updates after reconciliation touch.

- [ ] **Q.3 — Velocity score in trends API and company page**
  - Add `hiringVelocityScore` to P.2 `GET /api/v1/trends/hiring`
    response items; add `sort=velocity_desc` sort option.
  - Add `hiringVelocityScore` + `velocityComputedAt` to
    `GET /api/v1/companies/:slug` response.
  - Surface on O.2 company page as prominent score block — same
    monospace/chartreuse-at-80+ treatment as signal score badge (spec
    §11.4). Label "HIRING VELOCITY" with disclaimer: "Based on pace,
    breadth, and persistence of public hiring activity. Not a
    prediction of intent or budget." (spec §14.3).
  - Verify: route tests asserting fields present in both endpoints.
