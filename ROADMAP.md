# ROADMAP.md

Detailed, sequenced task breakdown for the work remaining after Phase 0
(scaffolding) and the Phase 1 read-path (D1 schema + `GET` routes), both
complete as of 2026-07-27. `AGENTS.md` keeps the short status view and
repo-wide policy; this file is where a phase gets broken into ordered,
independently-verifiable tasks before anyone starts writing code, so
scope doesn't get discovered mid-implementation.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task below cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

**Why a separate file from AGENTS.md:** AGENTS.md's roadmap section
tracks five phases in ~120 lines total; that was enough detail for
Phase 0/read-path because each item was small and self-contained. The
write-path phase is not small — it's a write-repo layer, a classification
engine that doesn't exist yet, one adapter per provider (11 total), a
scheduler, a queue consumer with idempotency requirements, and admin
routes, all with cross-dependencies. Cramming that into AGENTS.md's
existing five-bullet-point section understated the scope and made it easy
to lose track of sequencing. This file exists to fix that; AGENTS.md
links here instead of re-describing it.

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
- Update `CHANGELOG.md` when a milestone completes, same as before.
  (Previously this also said to update AGENTS.md's roadmap section —
  that section no longer exists there; AGENTS.md now only carries
  cross-cutting policy/how-to-work content and points here for all
  status, including Phase 0/1 below. Don't recreate a duplicate status
  list in AGENTS.md.)

---

## Phase 0 — Scaffolding (complete)

pnpm workspace, `apps/web` (Next.js 16), `apps/api` (Hono Worker +
middleware chain), `packages/domain`, real D1/KV/Queue resources,
anti-abuse middleware, `lib/http/circuit-breaker.ts`. `pnpm -r
typecheck`/`lint` clean.

## Phase 1 — D1 schema + read paths (complete)

Full schema (`infrastructure/d1/migrations/0001_initial_schema.sql`),
`packages/db/src/{d1-client,signals-repo,companies-repo,facets-repo}.ts`,
all `GET` routes wired to real D1 queries with sort-aware cursor
pagination and `EXISTS`-subquery filters.

---

## Milestone A — Write-path repositories (`packages/db`) — complete

`sources-repo.ts` (`getDueSources`, `getSourceById`, `createSource`/
`updateSource` with `DuplicateSourceError`, `recordSourceRunStart`/
`recordSourceRunComplete`, `markSourceSuccess`/`markSourceFailure`) and
`jobs-repo.ts` (`upsertJob`, `insertJobObservation`,
`getJobsMissingFromRun`, `applyLifecycleTransition`). Idempotency gap
closed via migration `0004_job_observations_idempotency.sql`
(`UNIQUE(job_id, source_run_id)`). Seed fixtures
(`infrastructure/scripts/seed-local-d1.sql`: 20 companies, 20 sources,
60 jobs, 60 observations, 20 signals) verified against real query
shapes, not just row counts. `pnpm --filter @hiring-signals/db
typecheck` clean.

---

## Milestone B — Classification and lifecycle (pure logic, no D1) — complete

Lands in `packages/domain`. `title-normalize.ts`, `role-rules.ts`,
`classification.ts`'s `classifyJob()` (confidence formula
$C_{role} = 0.70C_{title} + 0.20C_{department} + 0.10C_{description}$,
auto-classify at ≥0.80), `lifecycle.ts`'s `computeLifecycleTransition()`
(2 missing runs → `possibly_closed`, 4 runs or 14 days → `closed`,
reappearance → `active` + `reopened_job`). 24 tests, `pnpm --filter
@hiring-signals/domain test` green.

---

## Milestone C — Signal generation (`new_job` only for v1 of this milestone)

Spec: §7 (signal model/scoring), §7.3 (deduplication). Scoped to
`new_job` only for v1 — the other signal types need historical volume
baselines that don't exist until `new_job` has run for a while (spec §20
Phase 1 step 5).

`packages/db/src/signals-write-repo.ts` (`createSignal`,
`appendSignalEvidence`, `findActiveSignal`, `refreshSignal` for the
dedup/upsert flow) and `packages/domain/src/signal-score.ts`'s
`computeNewJobScore()` implementing spec §7.2's formula
$S = \min(100, 35R + 25V + 20A + 10B + 10Q - P)$, $R = e^{-d/14}$
freshness decay. V/A/B fixed at a documented neutral 0.5 for v1 (real
baselines are a future milestone); Q is real classification confidence;
P is 0 (no penalty inputs yet). `SCORE_FORMULA_VERSION = "v1"` persisted
as `signals.score_version` per spec §7.2's recomputability requirement.
Wired into `apps/api/src/jobs/ingest-consumer.ts`'s per-job loop
(Milestone D): classify → dedup-check → create/refresh signal + evidence.

Two rounds of post-hoc code review (2026-08-04) found and fixed 12
defects across indexing, clamping, SQL parameterization, a
check-then-act race, and score validation — all committed in `8ffeb25
fix(signals): resolve defects in signal scoring and persistence`.
Verify: `pnpm --filter @hiring-signals/domain test` 72/72 green,
`pnpm --filter @hiring-signals/db typecheck`/`lint` clean, live-D1
`signals-write-repo.test.ts` 21/21 green against the real account.

---

## Milestone D — Scheduler, queue consumer, source-management scripts (`apps/api` + `infrastructure/scripts`)

Spec: §5.1 (flow), §5.2 (cadence math — already fully specified, just
needs implementing), §13.2 (middleware order), §13.3 (queue message,
idempotency), §13.4 (failure handling table), §13.5 (source management
is ops-only, no HTTP admin surface).

This is the milestone that turns Milestones A–C from "code that exists"
into "a running pipeline." Depends on all three being done first.

`apps/api/src/jobs/scheduler.ts` enqueues `IngestMessage`s for due
sources (`getDueSources`, deterministic per-source-id jitter per spec
§5.2, LIMIT-bounded per invocation) — never fetches directly, enforced
structurally by not importing any adapter. `scheduler.test.ts` (4
tests).

`apps/api/src/jobs/ingest-consumer.ts` runs the full pipeline (fetch →
validate → normalize → upsert → observe → lifecycle → classify →
signal) with idempotency on `(job_id, source_run_id)`/`runId`, and
per-branch failure handling for every row in spec §13.4's table (429,
transient 5xx, config 4xx, schema mismatch, anti-bot, D1/KV transient).
Structured logging per spec §16.1's field list, never logging
tokens/cookies/raw payloads. `ingest-consumer.test.ts` (10 tests)
covers the happy path, idempotency, multi-run lifecycle transitions,
and every §13.4 branch, using a hand-built in-memory `D1Client` fake
(established pattern in this repo) rather than local-D1/miniflare — a
real `wrangler dev --local` run against the actual Greenhouse fixture
is still worth doing before production traffic.

No `apps/api/src/routes/admin.ts` HTTP surface — confirmed removed
(`protectedWriteTier`, `turnstile.ts`, `TURNSTILE_SECRET_KEY` all gone).
**Superseded 2026-07-30 (spec §13.5a):** `routes/admin.ts` exists again
as a *different* design — not a reversal. The removed piece was a
cookie/Turnstile write-tier gate; what exists now is a narrow
secret-bearer-token (`ADMIN_SECRET`, `Authorization: Bearer`, never a
cookie) operator-only trigger for three idempotent pipeline actions
(source-run, scheduler-flush, reconcile). No source create/edit — that
stays the ops-script path below. `apps/web` has zero `/admin`
references, confirmed via grep.

Source management lives in `infrastructure/scripts/` as plain Node
(`.mjs`) CLI scripts — `add-source.mjs`, `update-source.mjs`,
`source-health.mjs`, `lib/d1-exec.mjs` — shelling out to `wrangler d1
execute --json` per query rather than importing the Milestone A repo
functions directly, since `D1Client` needs a live Worker binding that
doesn't exist in plain Node. This means the scripts' SQL duplicates
`sources-repo.ts`'s shape and needs manual sync if the schema changes.
Manual ingestion trigger is `update-source.mjs --run-now` (clears
`next_poll_at`, lets the real scheduler pick it up) rather than pushing
onto the queue directly, since Cloudflare Queues has no send-CLI and
reimplementing the pipeline in-script risked drift. `wrangler` requires
Node ≥22 (`nvm use 24.18.0`); pnpm/tsc/vitest are unaffected.

**Known gap:** no `createCompany` in `packages/db` — `add-source.mjs`
can only attach sources to an existing `company_id`; new-company
onboarding still needs a manual `INSERT INTO companies`. Tracked as an
open item, not built here.

Verified for real against a fresh local D1 seed (not just typechecked):
all three scripts create/reject/update/health-check correctly, confirmed
via follow-up `SELECT`s. Test-folder isolation (`src/*.test.ts` → sibling
`test/`) and a shared `lib/d1/unique-constraint.ts` helper (replacing
three near-duplicate copies) landed as separate follow-up commits.
`pnpm -r typecheck`/`lint`/`test` clean (94/94 tests) throughout.

---

## Milestone E — Remaining P0 adapters

Spec §20 Phase 3 step 1 groups these with "production hardening," after
the dashboard (Phase 2) — the spec's own priority order puts a working
UI over adapter breadth. **Sequence this milestone after Milestone F
(Phase 2 UI) unless there's a specific reason to front-load adapter
coverage** (e.g. a particular provider is needed to validate the pipeline
against real-world messier data before UI work starts — Greenhouse's
fixtures are clean by construction, so this is a legitimate reason to
pull one or two adapters earlier if lifecycle/classification edge cases
need more real shapes to test against; use judgment, don't treat the
spec's ordering as absolute if it stops making sense in practice).

Same contract every time (`AtsAdapter`: `provider`, `fetchBoard`,
`normalize`), same fixture-test pattern as `greenhouse.ts`. Each
provider verified against first-party API docs before writing its
schema (spec §21: never invent endpoints, verify source contracts
first) — several verifications (ashby, smartrecruiters, workable) hit
a network-proxy block on live fetch and fell back to docs-plus-shape-
reference instead, noted per-adapter rather than silently assumed.

**Built (8), each in `packages/adapters/src/{name}.ts` + fixtures +
tests, registered in `registry.ts`, re-exported from `index.ts`:**
- `lever` — bare top-level array response (not `{jobs:[...]}}`),
  structured `workplaceType` trusted over free-text location inference,
  only one timestamp field (`createdAt`) so it backs both posted/updated.
- `ashby` — no stable job id in the public feed, so `jobUrl` doubles as
  `externalJobId`; `isListed:false` jobs filtered per Ashby's own docs.
- `smartrecruiters` — accepts both list-envelope and flat-array shapes;
  keys/URLs fall back through `uuid`→`id`→action URL.
- `workable`, `recruitee` — same structural pattern (structured location
  field trusted first, free-text fallback; provider-specific key/URL
  preference order).
- `personio` — only P0 adapter on XML, not JSON; hand-rolled extractor
  (`xml-lite.ts`) rather than a full XML dependency for one provider; no
  per-job URL field, so URLs are constructed as `{host}/job/{id}`.
- `breezy` — public unauthenticated feed is distinct from Breezy's
  authenticated back-office API; `verbose=true` required for description.

Verify (current): `pnpm --filter @hiring-signals/adapters
typecheck`/`lint`/`test` clean, 114/114 adapter tests; `pnpm -r
typecheck`/`lint` clean across all 6 workspace projects.

**Coverage scope closed at 8, decided with the user 2026-08-04 — standing
decision, not a backlog gap.** Every additional adapter is permanent
maintenance surface (schema drift, fixture upkeep, silent-failure risk).
A future session should not propose a new provider without the user
raising it first.

**Not built — `teamtailor`, `jazzhr`: structurally gated, not
effort gaps.** Both providers require a per-account secret API key with
no public/unauthenticated tier and no board-token-derivable URL — this
repo's `board_token`-only source-config model (spec §8.2) has nothing
to construct a fetchable URL from, and building against the
authenticated API would mean per-company secret storage, which spec
§14.1 ("no secrets in source config") explicitly rules out absent a
real decision from the user. Revisit only if either ships a public,
derivable-URL feed, or the user decides secret storage is in scope.

**Not built — `bamboohr`: closed by scope decision, not a verification
failure.** Independent (non-first-party) sources describe a plausible
public `{company}.bamboohr.com/careers/list` endpoint matching this
repo's model, but no real customer board could be found to confirm it
first-party. If adapter coverage ever reopens, this is the best-
positioned candidate — but that's not scheduled.

Ops script's `ATS_PROVIDERS` list already covers all 11 canonical
providers; the 3 unbuilt ones simply have no `registry.ts` entry, so
`getAdapterForProvider` throws its typed `UnsupportedProviderError` —
correct behavior, not a bug. AGENTS.md's roadmap status reflects the
closed-at-8 scope.

---

## Milestone F — Dashboard UI (Phase 2, `apps/web`)

Spec §11 (Minimal Brutalist visual system), §12 (Next.js requirements),
§10 (UX spec — route map, filters, signal cards, detail view, empty/
loading/error states).

**UI/animation source of inspiration, decided with the user: `ArxivExplorer`**
(same "single-page dense dashboard" shape; same reuse decision Milestone I
made for search UX). **Rule: reuse animation mechanics and interaction
timing, never the visual styling** — ArxivExplorer's neon-cyberpunk
aesthetic (glow shadows, glassmorphism) directly conflicts with spec
§11's Minimal Brutalist system (black/white, hard edges, one scarce
accent, no gradients/blur/drop-shadows). Every ported component keeps
its *behavior* and gets its *appearance* rewritten against §11's tokens.

**Ported (behavior only, restyled to §11):** `ScrollProgress`'s
scroll-fraction bar (restyled to a solid accent line); `Card`'s hover
lift + corner-accent-growth pattern (mouse-tracking radial glow
explicitly dropped — that's the exact "floating translucent panel"
effect §11.1 rules out); `AnimatedTagline`'s per-character stagger-in
for the masthead (color-shift hover dropped; must add a
`prefers-reduced-motion` guard per spec §11.5 — ArxivExplorer's own
version lacks one, so this is a fix in the port, not a carry-over).

**Optional, lower-priority:** `DecryptedText`'s scramble-reveal, as a
candidate for the score badge — only if it never sacrifices score
legibility mid-scramble, since spec §11.1 puts content over decoration.

**Rejected, considered and declined — do not re-propose without
re-reading this:** `ParticleBackground` (Three.js particle field) and
`background-beams` (animated gradient beams). Both are pure ambient
decoration; spec §11.1 explicitly rules out gradients and
"stock illustration" motion for this dashboard.

**Reusable pattern, not built now:** `AchievementToast`'s event-driven
toast-queue mechanism — no gamification content in this product, but the
same queue shape fits a future "new signals" or "source degraded" notice
if one is ever wanted.

Search-specific components (`SearchBoxHome`, `SearchFilters`, etc.) are
covered by Milestone I.4's own note — same ArxivExplorer decision,
not duplicated here.

`framer-motion` is a new dependency this reuse requires (`apps/web` had
neither it nor `three` before F); pin to a React-19-compatible version,
since ArxivExplorer itself is still on React 18. `three` is not needed —
`ParticleBackground` is the one component rejected above.

**Status (2026-08-04): Complete.**

All subtasks F.1 through F.7 are fully implemented and passing across `apps/web`:

- [x] **F.1 — Layout & AppShell (`apps/web/app/layout.tsx`, `components/app-shell.tsx`)**: Minimal Brutalist container, header masthead, mobile navigation toggle, zero-auth public accessibility.
- [x] **F.2 — Design System & Tokens (`apps/web/app/globals.css`)**: Minimal Brutalist design system implementation — black/white core palette, hard borders, scarce chartreuse accent, custom typography tokens.
- [x] **F.3 — Primitives (`components/ui/*`)**: Brutalist buttons, tags, input controls, badges, and card wrappers without glassmorphism/gradients.
- [x] **F.4 — Signal Feed & Filter Rail (`/signals`, `components/filter-rail.tsx`, `components/signal-feed.tsx`, `components/signal-card.tsx`)**:
  - Filter Rail: role multi-select, company autocomplete combobox with debounced search, score presets, source selector, signal-type toggles, work mode filter, recency filter.
  - URL state synchronization (`lib/searchParams.ts`): bi-directional sync of all filter options with browser search params and history.
  - Keyset cursor pagination: fetch next page on scroll / manual load, sort-aware cursor handling (`score_desc`, `newest`, `company_asc`).
- [x] **F.5 — Signal Detail View (`/signals/[signalId]`, `components/signal-detail.tsx`)**:
  - Displays headline, summary, score badge, score breakdown components (V/A/B), rule definition, detection latency, source status / stale indicator (`lastSourceRunAt`).
  - Evidence table (`components/evidence-table.tsx`): lists underlying job observations with title, company, source, location, department, posted/observed dates, and canonical link.
  - Trend block: 7-day, 30-day, and 90-day hiring activity breakdown.
- [x] **F.6 — Empty, Loading & Error States**:
  - Skeleton screens preserving dense dashboard layout during fetch (`components/empty-state.tsx`).
  - Graceful empty state when filters return zero results, with reset-filters action.
  - Error boundary & retry UI for network or API errors.
- [x] **F.7 — Accessibility & Responsive Audit**: Keyboard navigation across filters and card lists, screen-reader attributes, mobile/desktop responsive design.

---

## Milestone H — Signal-quality logic pass

Spec §6.2 (classification), §7.1 (signal types), §7.2 (scoring), §5.2
(reconciliation cadence). Originated from a targeted logic-quality
review of `packages/domain` and the ingest-consumer's wiring, run
against what's actually on disk per AGENTS.md's "fix and verify"
policy. Found and closed four real gaps:

**H.1 — Classification: description-channel noise fix**
(`packages/domain/src/classification.ts`). Description text was scored
by the same phrase-matcher as title/department, so an incidental
mention of an adjacent role in the body text (e.g. "you'll collaborate
with our Security team") could knock a correctly title+department-matched
job below the auto-classify threshold. Fixed: description now only
contributes when it confirms a category title/department already
matched, or is the only evidence available (both other channels
matched nothing) — a description-only disagreement is dropped, not
counted as a competing vote. This makes a genuine 3-way disagreement
structurally unreachable (max distinct categories is now 2); the old
`>= 3` disagreement branch stays in code for defensiveness but is
documented as dead code under this design. Verify: `pnpm --filter
@hiring-signals/domain test` 41/41.

**H.2 — Shared company-role activity stats query**
(`packages/db/src/company-role-stats-repo.ts`). New
`getCompanyRoleActivityStats(client, {companyId, roleCategory, now})`
computes, in one round trip: `activeMatchingCount` (V input),
`newInLast14Days`/`newInPrior56Days` anchored on `first_seen_at` (A
input, matches spec §7.2's $N_{14}$/$N_{56}$ windows), and
`distinctLocationCount` (B input, also `multi_location`'s trigger
quantity). `EXPLAIN QUERY PLAN` against seeded data confirmed the
existing `idx_jobs_filters` index covers this — no new migration
needed. Foundation for H.3 and H.4, which both reuse this one call
rather than duplicating the SQL. Verify: `packages/db` 17/17.

**H.3 — Real V/A/B scoring** (`packages/domain/src/signal-score.ts`).
Replaces the `0.5` neutral-constant stub with three real functions:
`computeVolume = clamp(activeMatchingCount/5, 0, 1)` (5 is a documented
v1 choice, not spec-derived — revisit once real volume shows what
"high" looks like); `computeAcceleration(n14, n56) = clamp((n14 -
n56/4) / max(2, n56/4), 0, 1)` (spec §7.2's exact formula);
`computeBreadth = clamp(distinctLocationCount/3, 0, 1)` (3 matches
`multi_location`'s own trigger threshold, keeping the score component
and the signal type conceptually aligned). `SCORE_FORMULA_VERSION`
bumped `v1`→`v2` per spec §7.2's recomputability requirement. Wired
into `ingest-consumer.ts` right after classification, before scoring.
Verify: domain 52/52, api 18/18, workspace-wide 117/117.

**H.4 — Company-level signal generation** (`hiring_burst`,
`role_acceleration`, `multi_location`, `persistent_demand` — the four
of six signal types that were fully typed/specced but never created).
New `generateCompanySignals()` in `ingest-consumer.ts`, reusing H.2's
stats and H.3's acceleration component (no extra D1 round trip).
Thresholds: `hiring_burst` at `newInLast14Days >= 3`, `multi_location`
at `distinctLocationCount >= 3` (both spec-literal), `persistent_demand`
at `>= 30` days continuously active anchored on `first_detected_at`
(spec-literal, deliberately not `last_detected_at` — "persistent" means
stayed active throughout). `role_acceleration`'s cutoff is `>= 0.75`,
**not** the originally proposed `0.5`: `computeAcceleration`'s `max(2,
priorRate)` floor means a single job with zero prior history scores
exactly `0.5` by construction, so `0.5` would have flagged every
brand-new company+role pair's first tracked job as "accelerating" — a
real false-positive trap caught by running the full test suite before
shipping, not just new tests. Dedup/refresh reuses the existing
`findActiveSignal`/`createSignal`/`refreshSignal` unchanged (already
generic across `signalType`). Verify: api 23/23, workspace-wide 122/122.

**H.5 — Freshness anchor decision + reconciliation decay.** Investigated
whether `computeNewJobScore`'s `job.postedAt`-anchored freshness
violates spec §7.2's literal "days since most recent evidence
observation" wording. **Conclusion: not a bug, kept as-is** — it
reflects the product's actual optimization target (detection latency,
spec §1.1); anchoring on evidence-observation-time at creation would
make freshness constant at 1.0 for every signal with no way to ever
decay. **The real gap**: nothing recomputed a quiet signal's score
after creation, so a stale signal kept displaying its creation-time
score forever in a `score_desc` feed. Fixed with a separate
`computeReconciliationScore()` (same v2 component functions, different
anchor: days-since-`last_detected_at`), a new
`listSignalsNeedingReconciliation()` query (excludes signals already
reconciled in the current 24h window, so retries don't duplicate
evidence), and `apps/api/src/jobs/reconciliation.ts` — a daily
(`"0 6 * * *"`) job that refetches H.2's stats fresh, recomputes the
score, updates `score`/`score_version` only (never `last_detected_at`,
since reconciliation isn't new evidence), and appends a
`score_recomputed` evidence row. Per-signal failures log-and-skip
rather than getting ingest-consumer-grade retry/backoff — documented
in the file header as a deliberate v1 scope line, full hardening is
Milestone G territory. Verify: `pnpm -r typecheck`/`lint`/`test` clean
workspace-wide.

---

## Open questions to resolve before Milestone D is "done" (not blocking earlier milestones)

Carried over from spec §22 ("Open decisions to resolve before
production") to the extent they affect write-path implementation
choices — full list is in the spec, this is just the subset relevant to
Milestones A–D:

- [ ] Where do lifecycle thresholds (`2`/`4`/`14` from spec §5.4) live
      as "configuration, not hard-coded" — a constants module is enough
      for v1 per Milestone B, but confirm that satisfies the spec's
      intent or whether it needs to be admin-editable (D1-backed config
      table) before Milestone D ships to any real source.

- [x] `packages/db` has no `createCompany` (or any companies-repo write
      function) — found while building the source-management ops
      scripts above. Onboarding a genuinely new company currently
      requires a hand-written `INSERT INTO companies` via `wrangler d1
      execute` rather than a script. Add `createCompany(client, input:
      { slug, displayName, domain?, industry?, employeeBand? })` to
      `packages/db/src/companies-repo.ts` (currently read-only:
      `searchCompanies`/`getCompanyBySlug`/`getRecentSignalsForCompany`
      only) with a `slug` UNIQUE-constraint check mirroring
      `sources-repo.ts`'s `DuplicateSourceError` pattern, then either an
      `add-company.mjs` ops script or a `--create-company` flag on
      `add-source.mjs` (`infrastructure/scripts/`). Small — likely
      bundles cleanly with the next ops-scripts session rather than
      needing its own milestone.
  - **Status (2026-07-28): done.** `createCompany(client, input)` +
    `DuplicateCompanyError` added to `packages/db/src/companies-repo.ts`,
    same shape as `sources-repo.ts`'s `createSource`/
    `DuplicateSourceError` (`isUniqueConstraintError` helper duplicated
    rather than shared — a two-line function, and `packages/db` has no
    shared-internals module yet). `packages/db/src/companies-repo.test.ts`
    (4 tests): generated-id insert with `created_at === updated_at` and
    nullable fields defaulting to `null`, optional fields passed through
    when provided, `DuplicateCompanyError` thrown (not a raw D1 error) on
    a UNIQUE-constraint failure, and a non-UNIQUE D1 error re-thrown
    as-is.
  - `infrastructure/scripts/add-company.mjs` added as its own script
    (not a flag on `add-source.mjs`), same `.mjs`-over-`wrangler d1
    execute --json` pattern as `add-source.mjs`/`update-source.mjs` for
    the reasons documented in `lib/d1-exec.mjs`'s header (no live
    `D1Database` binding outside a Worker). Prints the new company's id
    for direct use as `add-source.mjs --company-id`.
  - **Caught mid-session, not taken on faith:** this file was found
    already sitting in the working tree, uncommitted, truncated after
    `parseArgs` — defined but never called, no `main()`, no INSERT, no
    duplicate-slug check. Same "looks complete, silently cut off"
    pattern as `seed-local-d1.sql` (Milestone A.1) and
    `ingest-consumer.test.ts` (Milestone D) before it. Completed to
    match `add-source.mjs`'s structure (arg validation → duplicate-slug
    pre-check → INSERT → confirmation message) rather than committed as
    found.
  - **Verified for real against local D1, not just typechecked:**
    `pnpm --filter @hiring-signals/db typecheck`/`lint`/`test` clean
    (11/11 tests); `pnpm -r typecheck`/`lint`/`test` clean across all 5
    workspace projects (77 tests total, only the 3 pre-existing
    `consistent-type-imports` warnings). Ran `add-company.mjs` against a
    real local D1 instance (`nvm use 24.18.0` first, wrangler's own
    Node-version requirement, same environment note as Milestone D's ops
    scripts): happy path confirmed via a follow-up `SELECT` (id, slug,
    all optional fields, matching `created_at`/`updated_at` — not just
    the script's printed success message), a re-run with the same slug
    correctly rejected with `DuplicateCompanyError`'s message and exit
    code 1, and a call missing `--display-name` correctly rejected.
    Test company deleted afterward; local D1 confirmed back at 20
    companies, matching Milestone A.1's documented seed exactly.
  - **Correction (2026-07-28, same day): a code review of this commit
    found 5 real issues** that this "done" status had not caught — same
    "verified but not exhaustively" gap the ops scripts' own header
    comments warn about elsewhere. Fixed in commit `3ca36ee` rather
    than leaving the status stale:
    - P1: `add-company.mjs`'s INSERT had no try/catch around the
      UNIQUE-constraint race (the SELECT pre-check is TOCTOU, not a
      guarantee) — a concurrent duplicate-slug run would have surfaced
      a raw D1 error instead of the script's own message. Fixed to
      mirror `createCompany`'s own try/catch.
    - P2: `?? null` in `createCompany` only normalizes null/undefined,
      not `""` — an empty-string optional would persist as `""`
      instead of `NULL`. Fixed with an `emptyToNull()` helper in both
      the repo function and the script.
    - P2: the "optional fields passed through" test used
      `expect.arrayContaining`, which doesn't catch swapped param
      positions. Replaced with exact positional assertions; added a
      dedicated empty-string-normalization test.
    - P3: `parseArgs` in `add-company.mjs` silently treated a flag
      immediately followed by another flag as that flag's value. Fixed
      to detect a following `--`-prefixed token and leave the value
      `undefined` so the required-argument check catches it.
    - P3: whitespace-only `slug`/`displayName` passed the truthiness
      check and would have persisted a blank row. Rejected explicitly
      in both the script (before any D1 call) and the repo function
      (defense in depth for future callers that bypass the script).
    All 5 verified: `pnpm -r typecheck`/`lint`/`test` clean (92 tests,
    up from 90), plus a real local-D1 run of the two new P3 cases and
    the empty-string-optionals happy path confirmed via direct
    `sqlite3` query (not just the script's printed output) —
    `wrangler d1 execute` itself hit an unrelated pre-existing
    `.wrangler/state` WAL issue on this machine (`_cf_ALARM` column
    mismatch, a Cloudflare-internal table, not `companies`);
    `sqlite3 ... PRAGMA integrity_check` on the underlying file
    returned `ok` and a direct query confirmed the insert/cleanup.
    Worth a fresh `.wrangler/state` before next relying on
    `wrangler d1 execute` locally, but didn't block verifying this fix.
    Test row cleaned up afterward, local D1 back to 20 companies.


---

## Milestone I — Semantic search (Workers AI + Vectorize)

Added at the user's request, inspired by `ArxivExplorer`'s hybrid-search
architecture (Workers AI `@cf/baai/bge-base-en-v1.5` embeddings +
Vectorize, queried alongside D1). Spec §9.4 ("Semantic search") is the
source of truth for this milestone's behavior.

**Scope, decided with the user up front:**
1. Free-text search over signals/jobs, layered onto the existing `q`
   param (which today is company-name-only substring match) — a
   semantic leg merged in by score, `q`'s existing contract unchanged.
   Ships first.
2. Classification assist: semantic similarity as an *additional* input,
   never a replacement for the deterministic rules — out of scope until
   the search feature (I.1–I.4) is done. Per spec §6.2, embedding
   generation can never be a requirement for classification to run; the
   pipeline must produce identical outcomes with Workers AI down or
   Vectorize empty.

**UI inspiration:** `ArxivExplorer/app/components/` — `SearchBoxHome`
(hero search + filter chips), `SearchFilters` (URL-param-driven
chip-toggle panel), `MoreLikeThisButton` (`?like=:id` push),
`RecentSearches` (localStorage last-N), `AbstractSearch` (paste-text
mode). Reuse UX mechanics only, restyle from scratch against spec
§11's Minimal Brutalist tokens — ArxivExplorer's neon-cyberpunk
aesthetic conflicts with it directly.

**I.1 — Vectorize index + Workers AI binding.** `hiring-signals-jobs`
index (768-dim, cosine, matching `bge-base-en-v1.5`'s documented
output), five metadata indexes (`companyId`/`roleCategory`/
`locationMode`/`status`/`postedAt`, all string) created before any
vectors existed — Vectorize metadata indexes can't be added
retroactively to already-upserted vectors, so this ordering mattered.
`[ai]`/`[[vectorize]]` bindings and `EMBEDDING_MODEL` (`[vars]`, not
hardcoded) added to `wrangler.toml` and `Bindings`. Verify:
`wrangler deploy --dry-run` confirms all 7 bindings resolve; `pnpm -r
typecheck`/`lint`/`test` 131/131.

**I.2 — Embedding write path.** `buildJobEmbeddingText`
(`packages/domain/src/embedding-text.ts`) assembles title + role +
department + location + truncated description; wired into
`ingest-consumer.ts` via `embedAndUpsertJob`, called after
`applyLifecycleTransition`, gated on content-change (not on whether
scoring produced a signal). Vector ID is the job's own D1 primary key;
metadata omits `roleCategory`/`locationMode` keys entirely when absent
(Vectorize doesn't accept `undefined`). **Never a hard dependency**:
the whole embed-and-upsert call is try/catch, log-and-continue — an
`AI.run`/`VECTORIZE.upsert` failure never fails the enclosing message
or blocks D1 writes, confirmed by a dedicated failure-path test.
Upsert idempotency (same vector ID overwrites cleanly, confirmed
against Cloudflare's docs, not assumed) means a retried queue message
never duplicates. Verify: happy-path + failure-path tests in
`ingest-consumer.test.ts`; workspace-wide 140/140.

**I.3 — Backfill script + query-side hybrid search.**
`infrastructure/scripts/backfill-embeddings.mjs` (plain Node, direct
Workers AI/Vectorize REST calls — deliberately not routed through any
`/admin` surface, which spec §13.5/§14.1 already killed). Query-side:
`apps/api/src/services/semantic-search.ts`'s
`findSemanticSignalMatches` embeds the query, queries Vectorize,
resolves hits to signals, caches query embeddings in KV for 24h, never
throws (degrades to empty array on any live-dependency failure). Pure
merge/ranking in `packages/domain/src/signal-search-merge.ts`
(`mergeSignalMatches`: keyword weight 1.0 vs semantic weight 0.6,
dedup by signal id). No dedicated `apps/api` route-level test yet (no
`apps/api/test/routes/` convention exists in this repo) — the
pure-logic core has full coverage and the service's own contract
degrades safely, so this is a tracked follow-up, not a blocker. Verify:
`signal-search-merge.test.ts` 7/7 (part of domain's 70/70), `pnpm -r
typecheck`/`lint` clean.

**I.4 — Search UI.** Built on top of Milestone F's already-landed
dashboard shell (F had landed by the time this started, so the "still
near-scaffold" framing in this item's original text was already
stale). `lib/searchHistory.ts` (SSR-safe localStorage recent-searches),
`components/search-bar.tsx` (250ms debounce, reuses the existing filter
state model, no new plumbing), `components/more-like-this-button.tsx`.
**Deviation, re-verified against spec §9.4 rather than assumed:**
"more like this" is `/signals?q=<headline>` (reusing the same semantic
search path), not an id-based Vectorize lookup — spec §9.4 states no
new query parameter is introduced for v1. `AbstractSearch`'s dedicated
paste-text UI stays deferred, though the shipped search bar already
accepts arbitrarily long pasted text through the same `q` field with
no server-side max-length, so the capability exists without a separate
UI. A per-item "matched via semantic" badge is scoped out per spec
§9.4's "no explainability guarantee in v1." No dedicated component test
convention exists yet in `apps/web` — a manual click-through is still
worth doing before relying on this for real traffic. Verify: `pnpm
--filter @hiring-signals/web typecheck`/`lint` clean, production
`build` exit 0 (confirms SSR guards work, not just typecheck).

- [ ] **I.5 — Classification assist (deferred until I.1–I.4 verified)**
  - Not detailed task-by-task yet — deliberately, per this milestone's
    scope decision. When started: semantic similarity between a job's
    embedding and each role category's centroid/exemplar set becomes an
    *additional* signal `classifyJob` can optionally consult only in the
    already-existing "low title confidence, need department/description
    disambiguation" path (spec §6.2 step 5) — never a gate on whether
    classification runs at all, and never able to push a job to
    `autoClassified: true` on its own if the deterministic channels
    (title/department/description per H.1's structured-channel guard)
    disagree. Expand this into real sub-tasks, spec-cited against the
    new §9.5 addendum's classification-assist section, before writing
    any `classification.ts` change — same "expand before starting"
    discipline this file already applies to Milestones F and G.

---

## Milestone J — Migrate test suite off in-memory fakes onto live Cloudflare resources

**Status (2026-08-05): done.** `AGENTS.md`'s testing policy section
(superseded 2026-07-30) is the source of truth for the target end
state; this milestone was the task breakdown for getting there.
Transport layer lives in `packages/test-support`: `live-d1-client.ts`/
`live-d1-database.ts` (`wrangler d1 execute --remote`),
`live-cf-bindings.ts` (direct REST for AI/VECTORIZE/KV, 90s vitest
timeouts). All 7 `packages/db/test/*.test.ts` files (the original 4
plus `jobs-repo.test.ts`, `sources-repo.test.ts`, and
`signals-export-repo.test.ts` — added afterward by Milestones K.2, H,
and L respectively, each migrated onto live D1 from the start) plus
all 3 `apps/api/test/jobs/*.test.ts` files
(`reconciliation.test.ts`, `scheduler.test.ts`,
`ingest-consumer.test.ts`) are migrated off in-memory fakes onto live
Cloudflare resources. Two permanent,
documented policy exceptions remain (see `AGENTS.md`): ATS adapter
mocking (`vi.mock("@hiring-signals/adapters")` — no live equivalent
exists for a real third-party ATS board) and in-memory `INGEST_QUEUE`
send-capture (a real send would deliver to the same queue the
deployed consumer is subscribed to).

### Inventory (2026-07-30) — every test file's original fake/mock usage

At the time this section was written, `sources-repo.test.ts` did not
exist on disk (added later by Milestone H, and `jobs-repo.test.ts`
later still by K.2 — both landed already using live D1, so neither
ever carried the fake shape below). `AGENTS.md`'s file list has since
been corrected to match.

**`packages/db/test/*.test.ts` (the original 4 files):** each defined
its own local
`createFakeClient()` — a plain `D1Client` object literal recording
calls and returning canned values. Most assertions checked the fake's
captured SQL text/params, not real behavior — migrated to seed real
rows and assert on real read-backs. `signals-repo.test.ts`'s
`toListItem` (pure function, no `D1Client`) needed no migration.
`signals-write-repo.test.ts`'s `listSignalsNeedingReconciliation` test
previously only asserted SQL-substring presence, never actually
exercising the aggregation or staleness filter — the live-seeded
version is a materially stronger test of the same logic, not just a
policy-compliance rewrite.

**`apps/api/test/jobs/*.test.ts` (3 files, three different fake
shapes, not interchangeable):** `scheduler.test.ts` used
`vi.mock("@hiring-signals/db")` plus `unusedBinding<T>()` Proxy
stand-ins for unused bindings (a "fail loud, not silent" design kept
in spirit post-migration). `reconciliation.test.ts` was the most
policy-incorrect of the three even pre-2026-07-30 — it mocked this
repo's own exported functions directly, not just the storage layer
beneath them. `ingest-consumer.test.ts` (1148 lines, 17→21 tests) had
three independent fakes: a hand-written ~25-branch in-memory D1 engine
(same migration approach as `packages/db`'s fakes, but chaining
multiple repo calls per test meant the seeded state needed to support
a full sequence, not one isolated before/after); ATS-adapter mocking
(flagged as needing its own explicit decision — `AGENTS.md`'s
zero-fake policy only ever covered D1/AI/Vectorize/KV, not third-party
HTTP with no live-Cloudflare equivalent; decided: accepted, not a
violation); and a `storeRawPayload` mock (fell cleanly under the
existing KV policy once `createLiveKvNamespace` was generalized past
the `CACHE` namespace).

- [x] **Migrate `apps/api/test/jobs/ingest-consumer.test.ts`** — 1125
      lines, 21 tests (8 happy-path, 9 failure-branch, 5 H.4
      company-signal-generation). `DB` → `createLiveD1Database()`, `AI`
      → `createLiveAiBinding()`, `VECTORIZE` → `createLiveVectorizeIndex()`,
      `RAW_PAYLOADS` → `createLiveKvNamespace("RAW_PAYLOADS")`. Zero
      `vi.mock("@hiring-signals/db")`; only the two documented
      permanent exceptions remain. Cleanup: FK-safe teardown order,
      `test-ic-`-prefixed slugs, try/finally + afterEach sweep,
      best-effort Vectorize vector cleanup by job id. Initial run:
      ~1501s across all 21 tests, exit 0, real `ingest_success`/
      `ingest_failed`/`ingest_programmer_error` events confirmed.
      **Update (2026-08-03): that exit-0 result stopped reproducing
      reliably** — a later run of this file plus `reconciliation.test.ts`
      failed 27/32, and the single first-failing test alone still
      failed on its own: pipeline execution succeeded but total
      duration (113.76s) exceeded the 90s `testTimeout`. Root cause
      and fix options are written up in `AGENTS.md` rather than
      duplicated here; not re-closing this checkbox since it's the
      original exit-0 claim that's unverified, not the migration
      itself.
- [x] **CI workflow — typecheck + lint + fast pure-logic tests** ✅
      2026-08-02 (`.github/workflows/ci.yml`). Node pinned via
      `.nvmrc` (24.18.0), pnpm `11.17.0`, `--frozen-lockfile`, then
      `pnpm -r typecheck`/`lint` + `domain`/`adapters` test suites
      (70/70 + 114/114, ~4s combined, ~45s full pipeline incl.
      install). **Deliberately targeted, not `pnpm -r test`** —
      explicit repo-owner decision: `packages/db`/`apps/api`'s live-D1
      suites write real rows to production `hiring-signals` D1, run
      500–1500+s, and burn live Cloudflare quota on every commit —
      disproportionate to solo-maintainer CI needs. Run those
      manually before a release instead. Auth resolved same day:
      `CF_TOKEN` widened to add `D1: Edit` (same token value, no
      GitHub secret rotation needed). Along the way, removed 5
      tracked-but-unused one-off debugging scratch scripts from
      `packages/db` that were failing lint (`no-undef` on bare
      `console`), confirmed unreferenced elsewhere first.
- [x] **Live-D1 suites in CI, isolated (2026-08-05).** Of the three
      options this left open (accept shared-production risk / isolate
      / stay pure-logic-only), repo owner chose isolate. Provisioned
      `hiring-signals-ci` (region WEUR), migrations 0001–0006 applied
      and independently verified via a live `sqlite_master` query, not
      just the migration tool's own report. `wrangler.toml`'s new
      `[env.ci]` rebinds `DB` (same binding name — zero
      application-code changes needed). `d1-remote-transport.ts`
      gained `D1_DATABASE_NAME`/`D1_WRANGLER_ENV` env vars, defaulting
      to unchanged production behavior when unset. New
      `live-d1-tests` CI job runs only against the isolated database,
      `CLOUDFLARE_API_TOKEN` set as a real GitHub secret.
      **Scope is narrower than "the live-D1 suites," deliberately.**
      Checked all 10 live-D1 test files' imports individually: 9 use
      only `createLiveD1Client`/`createLiveD1Database` (isolable via
      `wrangler.toml`). The 10th, `ingest-consumer.test.ts`, also
      calls the AI/Vectorize/KV live-binding helpers, which hit
      Cloudflare's REST API directly with hardcoded account-level
      resource names — no config-driven way to isolate those the way
      D1 now has. Isolating D1 alone doesn't make that file safe to
      run automatically; it stays excluded from CI, manual-only. A
      real, deliberately-chosen scope boundary, not an oversight —
      repo owner confirmed "CI runs only D1-only suites; skip suites
      touching AI/Vectorize/KV for now" after the gap was surfaced.
      Verified for real: `pnpm -r typecheck` clean across all 6
      workspaces; `companies-repo.test.ts` and `scheduler.test.ts`
      (the two transport-consuming shapes) both pass against
      `hiring-signals-ci`, confirmed via direct row-count checks
      against both the CI database and production (no new rows from
      this session). One unrelated pre-existing orphaned test row was
      found in production during verification (a single row, not a
      systemic leak) — left in place and flagged to the repo owner
      directly rather than deleted unasked. Full narrative in butler
      session memory (`HiringSignals` project,
      `session-2026-08-05-ci-d1-isolation`).
- [x] Update `AGENTS.md`'s "Follow-up, tracked, not done today" note —
      done 2026-08-01, once `ingest-consumer.test.ts` actually landed.

### `packages/test-support` follow-ups (open, unresolved)

- [ ] `live-cf-bindings.ts`'s `loadCfToken()` (`.env.local` parser) only
      matches lines shaped exactly `CF_TOKEN=value`. Swap in a real
      dotenv parser, or document that only this exact shape is
      supported.
- [ ] `live-d1-client.ts`'s `execRemote` and `live-cf-bindings.ts`'s
      `runWrangler` are near-identical spawn-and-capture plumbing.
      Consider factoring into one shared helper so the two stay in
      sync as this grows.
- [ ] `live-d1-client.ts`'s `execRemote` has no credential preflight
      of its own, relies entirely on ambient wrangler auth — unlike
      `live-cf-bindings.ts`'s explicit `loadCfToken()`/clear
      "Missing CF_TOKEN" error. Decide whether to align or explicitly
      document why D1 differs.
- [ ] `live-d1-client.ts`'s `execRemote` includes full SQL text
      (params inlined) in every thrown error. Fine for debugging today
      given test-authored literal values, but worth a truncation/
      redaction strategy before this client is used more broadly.
- [ ] Add a short README/doc comment for `@hiring-signals/test-support`
      covering: which live Cloudflare resources each file touches,
      required env vars, what a missing-token failure looks like per
      file, and why these are real clients, not mocks (per `AGENTS.md`).

## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §14 (security controls, privacy posture, legal copy), §15
(performance/reliability targets), §16 (observability/ops), §18
(CI/CD), §19 (acceptance criteria).

Not a blank slate: `apps/api` already has a real middleware chain
(request-id, client-ip, security-headers, `freeReadTier` rate limiting,
`adminAuth` with SHA-256-hashed-IP strike lockout), a `RAW_PAYLOADS` KV
namespace with 30-day auto-expiry, and adapter fetch targets hard-coded
per provider in `registry.ts` (not DB-driven) — SSRF surface is small
by construction already. G is mostly a **verification and gap-closing
pass**: confirm what's built meets each spec §14/§15/§16 bullet, then
build only what's actually missing. No auth item: single-tenant,
public, no login, ever (spec §22 preamble).

G.1 (security audit) runs first — it determines which of G.2–G.5's
items are real gaps vs. already-satisfied. G.6/G.7 close the milestone
once G.1–G.5 land.

### G.1 — Security control audit against spec §14.1 (do this first) — ✅ done 2026-08-03

Final disposition of all 8 §14.1 bullets: 6 ✅ fully satisfied
(unauthenticated public routes confirmed via `freeReadTier()`; SQL
parameterization confirmed via full grep sweep of `packages/db/src/*.ts`
— `where`/`args` built as parallel arrays, values always flow through
`?` placeholders, LIKE-pattern `q` search escapes `%`/`_`, no injection
surface found; external-payload validation confirmed — every adapter
runs responses through a Zod schema; SSRF allow-listing confirmed by
construction — `registry.ts`'s adapter map is code-defined, hosts are
hard-coded string literals, only `boardToken` is interpolated,
`encodeURIComponent`-escaped; log redaction confirmed via full sweep of
19+ `console.*` call sites in `apps/api/src` — structured fields and
error messages only, never raw `Error` objects/headers/payload bodies,
IPs logged as SHA-256 hashes; `apps/api` security headers confirmed via
`security-headers.ts`). 1 partial → closed in G.2 (dependency
scanning: lockfile existed, CI audit step didn't). 1 gap identified,
tracked as a blocking check before Milestone F.5 ships (job-description
sanitization/no `dangerouslySetInnerHTML` — unverifiable until
`apps/web` renders any job descriptions). `apps/web` CSP gap
(same one Milestone F.1 independently flagged) tracked and closed in
G.2, not duplicated in F.

### G.2 — Close confirmed gaps from G.1 — ✅ done 2026-08-03

- [x] **CI dependency scanning** — added `pnpm audit --audit-level=high
      || true` (non-blocking) to `.github/workflows/ci.yml`'s
      `fast-checks` job. Baseline run: 13 findings (1 critical, 7 high,
      5 moderate), all devDependency-only or an unexercised feature —
      none is live runtime-exposed surface today (`vitest`'s critical
      finding requires its UI server, never started in this repo;
      `sharp`'s finding is via `next/image`, unused since no remote
      image hosts are configured yet — re-flag once one is). Recorded
      as a dated baseline for future `pnpm audit` diffing rather than
      re-triaging from zero each time; revisit `vitest`/`sharp`
      specifically at the next dependency-bump pass.
- [x] **SSRF invariant documentation** — added an explicit doc comment
      to `adapter-contract.ts`'s `AtsAdapter` interface: adapters MUST
      hard-code their request host as a string literal, only path
      segments may come from `SourceConfig`.
- [x] **`apps/web` security headers/CSP** — added `next.config.ts`
      `headers()`: `X-Content-Type-Options`, `Referrer-Policy`,
      `Permissions-Policy`, and a CSP (`default-src 'self'`,
      `connect-src` scoped to the API base URL, `frame-ancestors
      'none'`, `style-src` allows `'unsafe-inline'` for Tailwind).
      **Correction (found during F.2):** the CSP as first shipped
      applied `script-src 'self'` unconditionally, which broke `next
      dev` itself (Turbopack HMR + React dev-mode `eval()` both
      blocked). Fixed to scope `'unsafe-inline'`/`'unsafe-eval'` to
      `PHASE_DEVELOPMENT_SERVER` only via Next's `phase` argument
      (`NODE_ENV` proved unreliable on this machine). Production's
      `script-src 'self'` unchanged, reverified clean.
- [x] Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint`
      clean; G.1's SQL/log sweeps didn't need re-running since neither
      was touched by these changes.

### G.3 — Privacy posture (spec §14.2) + legal copy (spec §14.3)

- [ ] Confirm no candidate-personal-data fields (names, emails, resumes)
      are captured anywhere in the ingestion pipeline — spot-checked
      `greenhouseJobSchema` (job/org fields only), extend the check to
      every adapter's Zod schema.
- [ ] Operator-accessible source removal workflow (§14.2: disable a
      source + remove retained raw payloads on request, after legal
      review) — check whether `update-source.mjs` already covers
      "disable"; raw payloads already auto-expire after 30 days
      (`raw-payload-store.ts`) — confirm whether an immediate-delete
      path is needed beyond that passive expiry.
- [ ] Footer/legal copy — spec §14.3 requires this **verbatim** string
      somewhere in the app: "Signals are derived from publicly
      accessible job listings and may be incomplete or outdated. Verify
      current information at the linked source before contacting an
      organization." Belongs in Milestone F's `app-shell.tsx` footer;
      tracked here since it's a spec §14 requirement.
- [ ] Audit signal/summary copy for the forbidden phrasing spec §14.3
      calls out ("actively buying," "in market," "budget approved") —
      check `buildHeadline`/`buildSummary` (Milestones C/H/K) use only
      the sanctioned phrasing.
- [ ] Verify: grep for the three forbidden phrases across
      `packages/domain/src` and `apps/api/src`.

### G.4 — Performance targets verification (spec §15)

Mostly verification against already-built infrastructure (facet KV
cache, cursor pagination, indexed queries) rather than new work.

- [ ] Measure actual p95 latency for cached facet response and
      uncached `/api/v1/signals` (targets: facet < 250ms, uncached
      signals query < 800ms for 50 results) — needs a realistic seeded
      row count, not just the 20-company fixture; decide seed-data vs.
      synthetic-dataset tradeoff before treating a pass/fail as
      meaningful.
- [ ] Confirm first dashboard payload stays ≤ 50 signal rows — cross-
      check once Milestone F.4 ships that its default `limit` matches.
- [ ] Confirm Queues/D1 daily usage stays ≤ 85% of free-tier allowance —
      needs real production traffic or a synthetic load estimate;
      likely not answerable until Milestone E's adapters have run
      against a real source cohort for a while.
- [ ] Confirm source ingestion success rate ≥ 98% and duplicate job
      rate < 1% — both measurable now from `source_runs`/`jobs`;
      write a repeatable ops-script query (extend `source-health.mjs`?)
      rather than a one-off check.
- [ ] Verify: record actual measured numbers against each spec §15
      target, dated, so drift is detectable later.

### G.5 — Observability: structured events + alerting (spec §16)

- [ ] Audit `ingest-consumer.ts`'s structured log events against spec
      §16.1's required field list (`request_id`, `source_id`, `provider`,
      `run_id`, `adapter_version`, `http_status`, `duration_ms`,
      `jobs_received`, `jobs_normalized`, `signals_created`,
      `error_code`) — confirm every field is actually emitted, not just
      some; note any gap.
- [ ] `source-health.mjs` ops script — confirm it already implements
      spec §16.2's compact table (Source/Company/Provider/Last
      success/Next poll/Jobs/Failures/Status) and the four status
      definitions (Healthy/Delayed/Degraded/Disabled) — this predates
      this roadmap expansion (Milestone D), verify it matches the
      spec table exactly rather than assuming.
- [ ] Alerting (spec §16.3: provider-wide failure > 20%/1h, source
      missing 24h+ beyond cadence, schema mismatch, queue retries
      exhausted, API 5xx threshold, D1 query duration regression) — spec
      explicitly frames this as "alert *the operator*, not user-facing
      push" (§20 Phase 3 step 4). Given no dashboard/paging
      infrastructure exists yet, decide the actual delivery mechanism
      for a solo-maintainer project (e.g. a periodic ops-script run
      that prints an alert-worthy table, vs. real push/email) before
      building — don't assume a notification service is in scope
      without deciding this first.
- [ ] Verify: confirm each alert condition above is at least
      *computable* from existing structured logs/D1 tables today, even
      if delivery isn't automated yet — flag any condition that needs a
      new logged field to even be computable.

### G.6 — CI/CD hardening (spec §18)

Spec §18 describes a 4-environment model (Local/Preview/Staging/
Production) and a 7-step deployment sequence. Current CI
(`.github/workflows/ci.yml`) covers typecheck/lint/fast-tests only — no
deploy automation exists yet per this session's read of the workflow
file.

- [ ] Decide realistic environment scope for a solo-maintainer project —
      spec's 4-tier model (with separate Preview/Staging D1 registries)
      may be more process than a single maintainer needs; consider
      collapsing to Local + Production with a manual smoke-test step
      before promoting, and document that deliberate simplification here
      (same "explicitly discussed and decided" pattern Milestone J's CI
      scope decision used) rather than silently diverging from spec §18.
- [ ] If any deploy automation is added: never point preview/staging at
      production secrets or write bindings (spec §18.1) — a hard
      constraint regardless of how simplified the environment tier
      structure ends up.
- [ ] Rollback readiness (spec §18.3): confirm Cloudflare Workers
      versioned deployments are actually in use (not just theoretically
      available) and that a rollback has been test-run at least once
      manually, not just assumed to work.
- [ ] Feature-flag pattern for scoring formula changes (spec §18.3) —
      check whether `score_version`/`velocity_score_version` fields
      (already in the schema per Milestone C/Q) are sufficient for this,
      or whether an actual runtime flag mechanism is needed; likely
      already sufficient given versioned fields exist — confirm rather
      than build something new.

### G.7 — Acceptance criteria sign-off (spec §19)

Run this last, after G.1–G.6 and Milestone F are both complete — several
§19 items are UI-dependent (F) and several are backend-dependent (G).
Don't attempt this checklist until both are done; it's a joint
sign-off, not a G-only task.

- [ ] Walk every checkbox in spec §19.1 (functional), §19.2 (visual/
      interaction), §19.3 (security/operations) and mark pass/fail with
      a one-line note on how it was verified (manual test, automated
      test, code audit). §19.3 items are mostly backend/G; §19.2 items
      are entirely F; §19.1 is mixed.
- [ ] Any failing item gets its own follow-up task here rather than
      being silently marked "close enough."

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

- [x] **I.4 — Search UI** (`apps/web`, spec §11) ✅ verified 2026-08-05
  - **Correction to this item's original text:** "`apps/web` is still
    near-scaffold" was stale by the time this was picked up — Milestone
    F (dashboard: `app-shell.tsx`, `filter-rail.tsx` + all 6 individual
    filters, `signal-feed.tsx`, `signal-card.tsx`, `signal-detail.tsx`)
    and L.2 (export button) had already landed. `SearchFilters.tsx`'s
    chip-toggle → existing filters was therefore already done coming
    into this item, confirmed by reading `filter-rail.tsx` rather than
    assumed; the only genuinely missing piece was the search box itself,
    recent-searches, and more-like-this.
  - Built: `lib/searchHistory.ts` (SSR-safe localStorage recent-search
    list, capped/deduped), `components/search-bar.tsx` (debounced 250ms
    per spec 12.2's convention, reuses `use-debounced-value.ts` exactly
    as that file's own header comment anticipated), wired into
    `signals-view.tsx` above `SignalFeed` — both read/write the *same*
    `FilterState.q`/`toApiParams` plumbing I.3 already built, no new
    state model. `components/more-like-this-button.tsx` wired into
    `signal-detail.tsx`.
  - **Deviation from this item's original plan, both re-verified against
    spec 9.4 rather than assumed:** `MoreLikeThisButton` does NOT do
    ArxivExplorer's `?like=:id` id-based Vectorize `getByIds` lookup —
    spec 9.4 states plainly "no new query parameter is introduced for
    v1 of this addendum" and any future one "must be added here first...
    before being implemented." Implemented instead as
    `/signals?q=<signal.headline>`, reusing the exact same
    `findSemanticSignalMatches` embedding path the search bar already
    exercises. `AbstractSearch.tsx`'s dedicated paste-text-mode UI
    stays deferred exactly as this item's original text already flagged
    it — not built, but noted that the shipped search bar already
    accepts arbitrarily long pasted text through the same `q` field
    (no server-side max-length), so the underlying capability exists
    without a separate UI variant.
  - **Scoped out, not silently skipped:** a per-item "matched via
    semantic" badge (spec 9.4's own "no guarantee of semantic-match
    explainability in v1" — `mergeSignalMatches`'s `matchedVia`/
    `similarity` are computed server-side but deliberately not returned
    to the client) and a separate aggregate "N filters active" badge
    (the `SearchFilters.tsx` parenthetical in this item's original
    text — judged already covered by each individual filter control's
    own selected-state styling, not a named checklist item of its own).
  - Verified 2026-08-05: `pnpm --filter @hiring-signals/web typecheck`
    clean, `pnpm --filter @hiring-signals/web lint` clean (0 errors),
    `pnpm --filter @hiring-signals/web build` exit 0 — real Next
    production build, not just typecheck, so `/` and `/signals`'s
    static prerender actually executed the new components server-side
    (confirms `searchHistory.ts`'s `isBrowser()` SSR guards work, not
    just that they typecheck). No dedicated component test exists yet
    (no test file convention for `apps/web` established in this repo
    so far) — a manual click-through in a running `next dev` session is
    still worth doing before relying on this for real traffic, same
    caveat I.3 already left for its own missing route-level test.

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
    `last_seen_at` cutoff was a string comparison (SQLite `datetime()`
    output vs. ISO timestamps) letting stale jobs through, and the
    call site never passed a real `now`. Both fixed. All 6
    `reconciliation.test.ts` tests pass against live D1.

- [x] **K.2 — Detection-latency tracking** — ✅ done 2026-08-01
      (`packages/db/src/jobs-repo.ts`,
      `infrastructure/scripts/source-health.mjs`)
  - `getDetectionLatencyStats(client, { sourceId?, companyId?, since? })`
    in `packages/db/src/jobs-repo.ts` — `first_seen_at` −
    `source_runs.started_at` via `job_observations` → `source_runs`,
    MIN(observed_at) grouping so a later re-poll of the same job
    doesn't skew the sample. Returns `p50LatencyMinutes`,
    `p95LatencyMinutes`, `sampleCount`.
  - `source-health.mjs` gained a `p50 latency` column, computed via a
    correlated scalar subquery duplicating the repo function's query
    shape by hand (ops scripts shell out through `wrangler d1 execute`
    and can't import `@hiring-signals/db` directly). Spec §20 Phase 3
    step 6's concrete output.
  - Verified: `jobs-repo.test.ts` (12 tests, live D1) covers null/zero
    baseline, MIN-observation grouping, and source/company filtering;
    manual `source-health.mjs` run confirmed the column renders.

---

## Milestone L — CSV export (`GET /api/v1/export/signals.csv`)

Spec §2.1 (P0 feature), §9.2 (endpoint listed), §8.3 (export artifacts
expire after 24h in KV). Listed "not yet built" in README. Only P0
spec-required feature with no prior milestone.

**Why this adds value:** secondary audience (investors, recruiters)
needs filtered signal export for offline analysis. Without export, the
dashboard is read-only.

`GET /api/v1/export/signals.csv` (`apps/api/src/routes/export.ts`)
accepts the same query params as `GET /api/v1/signals` and returns
`text/csv` (v1 cap: 2000 rows, `X-Export-Truncated: true` if exceeded).
Backed by a new `listSignalsForExport` (`packages/db/src/signals-repo.ts`)
rather than reusing `listSignals` — export needs no pagination and two
extra columns (`canonical_url`, `source_platform`) resolved via a
"most-recently-observed evidence" LEFT JOIN. Company-level signals
(hiring_burst etc.) with no job-linked evidence render those columns
as empty cells, not an error. `lib/text/csv.ts` is a small dependency-free
RFC 4180 encoder. `ExportButton` in the dashboard (`apps/web`) builds
the download URL from current search params via `buildExportUrl`.
No dedicated route-level HTTP test (same gap I.3 already notes); the
route has no logic beyond parse/call/serialize. Verify: `packages/db`
export-repo tests 5/5 against live D1, `pnpm -r typecheck` clean.

---

## Milestone M — Bulk source onboarding (CSV import)

Spec §2.2 (P1: "Manual company/source onboarding from a CSV"), §22
open decision 2 (registry growth bottleneck). Removes the
one-invocation-per-source friction of `add-company.mjs`/`add-source.mjs`
— a prerequisite for registry growth.

`infrastructure/scripts/import-sources.mjs` takes a CSV path
(`company_slug`, `company_display_name`, `company_domain?`, `provider`,
`board_token`, `public_url`, `poll_interval_minutes?`). Two-pass design:
pass 1 validates the whole file against live D1 and prints a per-row
`[OK]`/`[SKIP]`/`[ERROR]` plan; pass 2 only writes if zero rows are
invalid. One company created per slug even across multiple rows;
duplicate `provider`+`board_token` (in-file or already in D1) is a
skip, not fatal — idempotent, confirmed on a real second run against
local D1 (0 created, all rows skipped). Same `.mjs`-over-`wrangler d1
execute` pattern as every other ops script.

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
