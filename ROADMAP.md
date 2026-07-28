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

pnpm workspace, strict TS base config, shared ESLint base, Next.js 16 +
Tailwind `apps/web`, Hono Worker `apps/api` with the
request-id/security-headers/error-handler middleware chain, `packages/domain`
(role taxonomy, ATS provider enum, NormalizedJob/Signal/IngestMessage Zod
schemas), a provisioned D1 database + KV namespace + Queue (`wrangler.toml`
has real resource IDs, no R2 — raw payload archive lives in KV under
TTL'd keys instead, so the project doesn't require Cloudflare billing).
Anti-abuse middleware (`freeReadTier`/rate-limit + audit logging) is wired
onto the read routes. `lib/http/circuit-breaker.ts` wraps every D1 call
via `lib/d1/client.ts` (not per-repo-function). Workspace-wide `pnpm -r
typecheck` and `pnpm -r lint` both clean across all 5 projects.

- [x] pnpm workspace, strict TS base config, Prettier, shared ESLint base
- [x] `apps/web` scaffold + `lib/api-client.ts` (calls the Worker API only,
      never ATS providers directly, spec §12.1)
- [x] `apps/api` Hono Worker + middleware chain + `wrangler.toml` bindings
      + 15-minute scheduler cron config (spec §13.1)
- [x] `packages/domain` core schemas
- [x] Real D1/KV/Queue resources provisioned (not placeholders)
- [x] Anti-abuse middleware (rate-limit + audit logging) on read routes
- [x] `lib/http/circuit-breaker.ts` wired into `lib/d1/client.ts`

## Phase 1 — D1 schema + read paths (complete)

Full schema per spec §8.2 (`infrastructure/d1/migrations/0001_initial_schema.sql`),
parameterized D1 client wrapper, cursor-paginated signal feed with
sort-aware cursors (`score_desc`/`newest`/`company_asc` each encode their
own comparison columns — a cursor issued for one sort throws
`InvalidCursorError` if replayed against another), company autocomplete/
detail/recent-signals, KV-cached facet counts, and all `GET` routes
(`/api/v1/signals`, `/signals/:id`, `/companies`, `/companies/:slug`,
`/facets`) wired to real D1 queries. `locationMode`/`country`/`source`
filters use `EXISTS` subqueries through `signal_evidence` → `jobs` (never
a plain `JOIN`, which would duplicate signals with multiple evidence rows
matching the filter).

- [x] `infrastructure/d1/migrations/0001_initial_schema.sql`
- [x] `packages/db/src/d1-client.ts` (parameterized `.bind()` wrapper)
- [x] `packages/db/src/signals-repo.ts` (cursor-paginated feed + detail)
- [x] `packages/db/src/companies-repo.ts`
- [x] `packages/db/src/facets-repo.ts` (KV-cached)
- [x] `apps/api` `GET` routes wired to real D1 queries
- [x] Sort-aware cursor pagination (bug fix, verified)
- [x] `locationMode`/`country`/`source` filters via `EXISTS` (bug fixes, verified)
- [x] Workspace lint fixed repo-wide (previously silently broken past the
      first package in run order)

---

## Milestone A — Write-path repositories (`packages/db`)

**Status (2026-07-28): both repo files below are implemented and
typecheck clean.** The idempotency schema gap flagged in
`jobs-repo.ts`'s `insertJobObservation` doc comment has been closed —
see migration `0004_job_observations_idempotency.sql` (adds
`UNIQUE(job_id, source_run_id)` via `CREATE UNIQUE INDEX`, since SQLite
has no `ALTER TABLE ADD CONSTRAINT`), applied to local D1 and verified
by a manual duplicate-insert test that confirmed the constraint fires.
`insertJobObservation`'s comment updated accordingly. A.1 (seed
fixtures) is still open below — nothing in this milestone has test
coverage yet because there's no seed data to test against.

Nothing downstream (adapters calling in, scheduler, consumer, admin
routes) can be built or even typechecked against real signatures until
this exists. Framework-agnostic — no `hono` import, same rule as the
read-path repos (see AGENTS.md "How to work in this repo").

Spec: §8.2 (schema), §5.4 (lifecycle), §14.1 ("Repository (SQL) code
lives only in packages/db").

- [x] `packages/db/src/sources-repo.ts`
  - `getDueSources(client, params: { now: string; limit: number })` —
    `SELECT ... FROM sources WHERE enabled = 1 AND (next_poll_at IS NULL
    OR next_poll_at <= ?) ORDER BY next_poll_at ASC LIMIT ?`. Uses
    `idx_source_due` (already indexed in migration 0001 — verify with
    `EXPLAIN QUERY PLAN` once seed data exists, don't just assume the
    index is hit).
  - `getSourceById(client, sourceId)` — single row, used by the queue
    consumer to re-load config per message.
  - `createSource(client, input)` / `updateSource(client, sourceId,
    patch)` — backs the ops source-management scripts (Milestone D,
    spec §13.5). `provider +
    board_token` UNIQUE constraint (migration 0001) means a duplicate
    insert throws a D1 constraint error; catch it and throw a typed
    `DuplicateSourceError` (same pattern as `InvalidCursorError` in
    `signals-repo.ts`) so the ops script (Milestone D) can print a clear
    message instead of a raw D1 error.
  - `recordSourceRunStart(client, input) -> sourceRunId` /
    `recordSourceRunComplete(client, sourceRunId, result)` — writes
    `source_runs` rows (spec §8.2 columns: `status`, `http_status`,
    `jobs_received`, `jobs_normalized`, `error_code`,
    `error_message_safe`, `raw_payload_key`, `duration_ms`).
    `error_message_safe` is exactly that — sanitized, no raw response
    bodies or secrets, matching spec §16.1's "never include ... full raw
    payloads" — enforce this in the function, not just by naming
    convention (strip/truncate before insert).
  - `markSourceSuccess(client, sourceId, nextPollAt)` /
    `markSourceFailure(client, sourceId)` — the former resets
    `consecutive_failures` to 0 and sets `last_success_at` +
    `next_poll_at`; the latter increments `consecutive_failures` only
    (spec §5.4: "Source run fails → do not alter missing counts" — this
    is about *job* missing counts, `sources.consecutive_failures` is a
    different counter and *does* increment on failure, don't conflate
    the two).
  - Verify: `pnpm --filter @hiring-signals/db typecheck`, plus a vitest
    file once seed fixtures exist (blocked item already flagged in
    AGENTS.md Phase 0 — see Milestone A.1 below).

- [x] `packages/db/src/jobs-repo.ts`
  - `upsertJob(client, input: NormalizedJob & { sourceId, companyId,
    contentHash })` — `INSERT ... ON CONFLICT(source_id,
    external_job_id) DO UPDATE SET ...` keyed on the schema's own
    `UNIQUE(source_id, external_job_id)` constraint (spec §5.3: "Use a
    unique job key of source_id + external_job_id"). On conflict, only
    update fields that can legitimately change between observations
    (title, description, location, status fields, `last_seen_at`,
    `content_hash`) — never overwrite `first_seen_at` or `id`.
  - `insertJobObservation(client, input: { jobId, sourceRunId,
    observedAt, contentHash, isPresent })` — one row per
    `(job, source_run)` per spec §8.2's `job_observations` table.
  - `getJobsMissingFromRun(client, sourceId, seenExternalIds: string[])`
    — the complement query the lifecycle step needs: jobs previously
    `active`/`possibly_closed` for this source whose `external_job_id`
    is *not* in the current run's result set. This is what feeds the
    missing-count increment in Milestone B; do not compute "missing" by
    diffing in application code across two full-table loads when a NOT
    IN / LEFT JOIN query does it in one round trip.
  - `applyLifecycleTransition(client, jobId, patch: { status,
    missingRunCount, lastSeenAt })` — single-purpose update, called by
    the lifecycle engine (Milestone B), not by adapters or the consumer
    directly. Keeps the state-machine *decision* (Milestone B, pure
    function, unit-testable without D1) separate from the state-machine
    *write* (this repo function).
  - Verify: same as above.

### A.1 — Seed fixtures (unblocks repo tests)

Already flagged as pending in AGENTS.md Phase 0 and referenced by the
existing "no test coverage yet for listSignals" note — both block on
this, so it's worth doing once, early, rather than deferring twice.

**Status (2026-07-28): done.** `infrastructure/scripts/seed-local-d1.sql`
existed on disk from a prior session but was silently truncated mid-way
through the `jobs` INSERT (cut off mid-row, no closing `;`, and the
`job_observations`/`signals`/`signal_evidence` INSERTs the file's own
header comment promised were entirely missing) -- a mismatch between the
file's apparent completeness and this checkbox's unchecked state, caught
per AGENTS.md's "only checked once verified" policy rather than trusted
on sight. Completed: closed the truncated `jobs` INSERT (60 rows, 20
companies x 3 jobs), added `job_observations` (60 rows, one per job keyed
to its source's single `source_runs` row), `signals` (20 rows, one active
`new_job` signal per company anchored to that company's most-recently-
posted job, score via spec 7.2's freshness-decay term only -- v1
simplification, documented inline in the header), and `signal_evidence`
(20 rows, one per signal).

- [x] `infrastructure/scripts/seed-local-d1.sql`: 20 companies, 20
      sources (all 11 ATS providers represented), 20 `source_runs`
      (status=success), 60 `jobs` (all 10 role categories, remote/
      hybrid/onsite across US/DE/GB, classification_confidence >= 0.80),
      60 `job_observations`, 20 `signals`, 20 `signal_evidence`.
  - Verify: applied cleanly against a scratch SQLite DB seeded with
    migrations 0001-0004 in order (zero errors, including migration
    0004's `UNIQUE(job_id, source_run_id)` idempotency index -- no
    duplicate `(job, run)` pairs in the seed data). Row counts confirmed
    against every table. The exact query shape `listSignals` runs
    (`status='active' AND score >= ? AND last_detected_at >= now-30d`,
    joined to `companies`, sorted `score DESC, last_detected_at DESC, id
    DESC`) was run directly against the seeded DB and returned all 20
    signals correctly joined and sorted -- not just a raw table count.
    `wrangler d1 execute hiring-signals --local --file=...` against the
    real D1 binding (and a live `GET /api/v1/signals` against local dev)
    is still worth a quick confirm before relying on this for D1-specific
    behavior (e.g. D1's SQL dialect quirks vs. stock SQLite), since the
    check above used SQLite directly rather than D1's local emulation.

---

## Milestone B — Classification and lifecycle (pure logic, no D1)

Spec: §6.2 (classification), §5.4 (lifecycle table), §6.4 (location —
already done via `packages/adapters/src/location.ts`).

This is pure, D1-free logic on purpose — spec §6.2 opener is explicit
("Use deterministic rules first. Do not make an LLM dependency necessary
for the ingestion pipeline") and pure functions are fixture-testable the
same way `greenhouse.test.ts` tests `normalize()` without a network call.
Lives in `packages/domain` (taxonomy/types already there) or a new
`packages/classification` — decide based on whether `packages/adapters`
would need to import it too (title-based pre-filtering at fetch time is
out of scope for v1, so probably not; default to `packages/domain` unless
that turns out awkward).

**Status (2026-07-28): done, landed in `packages/domain`.** All five
items below implemented and verified: `pnpm --filter @hiring-signals/domain
typecheck` clean, `pnpm --filter @hiring-signals/domain test` green (24/24
tests across `title-normalize.test.ts`, `classification.test.ts`,
`lifecycle.test.ts`), `pnpm --filter @hiring-signals/domain lint` clean,
and `pnpm -r typecheck` confirmed nothing downstream broke. Two real bugs
were caught and fixed during this pass (not just assumed passing): two
of the classification test fixtures used department strings like "Site
Reliability Engineering" that didn't actually match the phrase rule
"site reliability engineer" under word-boundary matching ("engineering"
≠ "engineer") — fixed by correcting the fixtures, not the matcher, since
the matcher's behavior (no partial-word matches) is correct per spec
§6.2's precision requirement.

- [x] Title normalization: lowercase, Unicode-normalize (NFKC), strip
      punctuation, collapse whitespace (spec §6.2 step 1). Small, pure,
      easy to over-engineer — keep it to exactly what the spec lists.
  - `packages/domain/src/title-normalize.ts`.
- [x] Phrase-rule + abbreviation matcher against the 10 P0 role
      categories (`packages/domain/src/role-taxonomy.ts`), spec §6.2
      steps 2–3. Rules are data (a table/JSON of phrase → category, and
      abbreviation → category), not a long if/else chain — makes the
      "labeled fixture set" testing requirement (spec §6.2 step 7,
      §17.1) tractable.
  - `packages/domain/src/role-rules.ts` (`PHRASE_RULES`,
    `ABBREVIATION_RULES`); matching logic in `classification.ts`.
- [x] Negative-term guard (spec §6.2 step 4) — e.g. "security guard"
      must not match `cybersecurity`. Applied *before* a phrase match is
      accepted, not as a post-hoc filter.
  - `role-rules.ts`'s `NEGATIVE_TERM_RULES`, checked inside
    `matchTextAgainstRules()` before a candidate match is returned.
- [x] Confidence scoring: $C_{role} = 0.70C_{title} + 0.20C_{department}
      + 0.10C_{description}$ (spec §6.2 formula), department/description
      inspection only when title confidence is low (step 5). Auto-classify
      only at $C_{role} \geq 0.80$; store `classification_confidence` and
      `classification_version` either way (step 6); below-threshold jobs
      still get written with `role_primary = null`, not dropped or
      blocked (step 7 — "review queue" doesn't require a UI *now*, but
      the job record itself must make low-confidence items queryable
      later, so don't silently discard the raw signal).
  - `classification.ts`'s `classifyJob()`; `AUTO_CLASSIFY_THRESHOLD` and
    `CLASSIFICATION_VERSION` exported as named constants. Note: title-only
    confidence is capped at the 0.70 title weight and can never alone
    reach the 0.80 auto-classify threshold by construction of the
    formula — reaching auto-classify requires a title match plus at
    least a department or description assist, or a low-title-confidence
    case where department+description both independently match.
    `rolePrimary` is still returned (with `autoClassified: false`) below
    threshold rather than discarded, satisfying step 7.
- [x] Job lifecycle state machine as a pure function: `(currentState,
      wasPresentThisRun, consecutiveMissingRuns, daysSinceLastSeen) =>
      nextState` implementing spec §5.4's table exactly (2 consecutive
      missing runs → `possibly_closed`; 4 consecutive OR 14 days →
      `closed`; reappearance → `active` + emit `reopened_job`
      candidate). Thresholds (`2`, `4`, `14`) must be named constants,
      not inlined magic numbers, per spec §5.4 ("must be configuration,
      not hard-coded") — a config object/module is enough for v1, a full
      admin-editable setting can come later per §22 open decisions.
  - `packages/domain/src/lifecycle.ts`'s `computeLifecycleTransition()`;
    constants `POSSIBLY_CLOSED_AFTER_MISSING_RUNS`,
    `CLOSED_AFTER_MISSING_RUNS`, `CLOSED_AFTER_DAYS`. "Source run fails"
    (spec's "do not alter missing counts" row) is deliberately not a
    branch inside this function — the ingest consumer (Milestone D)
    simply must not call it for a failed run, which is the only way to
    *guarantee* the counts are untouched rather than trusting an extra
    conditional not to be miscalled.
- [x] Fixture-driven tests for all of the above, modeled on
      `packages/adapters/src/greenhouse.test.ts` / `location.test.ts`
      (`vitest`). Cover: the "security guard" negative case explicitly
      (spec calls it out by name), a title-only high-confidence match, a
      low-confidence case that needs department disambiguation, and each
      row of the lifecycle table as its own test case.
  - Verify: `pnpm --filter @hiring-signals/domain test` (or whichever
    package this lands in) green; `pnpm -r typecheck` clean.
  - Done: `title-normalize.test.ts` (5 tests), `classification.test.ts`
    (11 tests, including the named "security guard" case and a
    "physical security" variant), `lifecycle.test.ts` (8 tests, one per
    table row plus present-while-possibly_closed and
    present-while-active edge cases).

---

## Milestone C — Signal generation (`new_job` only for v1 of this milestone)

Spec: §7 (signal model/scoring), §7.3 (deduplication), §20 Phase 1 step 5
("Implement new_job signal generation and evidence persistence" — the
spec's own build order limits Phase 1 to this one signal type;
`hiring_burst`/`role_acceleration`/`multi_location`/`persistent_demand`
need historical volume baselines that don't exist until `new_job` has
been running for a while, so they're a later milestone, not deferred
arbitrarily here).

**Status (2026-07-28): score computation and the write-repo are done and
verified; the ingest-consumer wiring item is intentionally still open
below since it depends on Milestone D's consumer, which doesn't exist
yet.** `pnpm --filter @hiring-signals/domain test` and `pnpm --filter
@hiring-signals/db test` both green, `pnpm -r typecheck` clean across all
5 workspace projects. One real typecheck bug was caught and fixed in the
write-repo's own test file (not the write-repo itself): `D1Client`'s
`first`/`all`/`batch` methods are generic (`<T>(...) => Promise<T | ...>`),
and building the fake test client via `vi.fn()`-wrapped arrow functions
made TS infer a concrete non-generic signature that didn't satisfy the
generic interface -- fixed by building the fake as a plain object literal
with its own generic method signatures instead of `vi.fn()` wrapping.

- [x] `packages/db/src/signals-write-repo.ts` (separate file from the
      existing read-only `signals-repo.ts` — keeps the read/write split
      explicit and avoids one file mixing query-building styles):
      `createSignal(client, input)`, `appendSignalEvidence(client,
      signalId, evidence)`, `findActiveSignal(client, { companyId,
      roleCategory, signalType })` (dedup check before creating a new
      row — spec §7.3 hard-duplicate rule applied at the signal level).
  - Done. Also added `refreshSignal(client, signalId, input)` (not
    originally listed here, but required by the dedup flow: when
    `findActiveSignal` finds a match, the caller needs a way to update
    that row's score/last_detected_at rather than only being able to
    create or append evidence — spec §7.3's "upsert one job" pattern
    applied at the signal level too, so a matching active signal is
    refreshed, not duplicated).
  - Verify: `packages/db/src/signals-write-repo.test.ts` (7 tests, fake
    `D1Client` double asserting exact SQL/param shape for all four
    functions, including the null-jobId case for evidence not tied to a
    specific job); `pnpm --filter @hiring-signals/db typecheck` clean;
    `pnpm --filter @hiring-signals/db lint` clean.
- [x] Score computation as a pure function per spec §7.2's formula:
      $S = \min(100, 35R + 25V + 20A + 10B + 10Q - P)$, with
      $R = e^{-d/14}$ freshness decay. For v1 `new_job` signals, $V$/$A$/
      $B$ can be simple (a freshly-created signal has one piece of
      evidence, so volume/acceleration/breadth start low/neutral —
      document the exact v1 simplification in the function's header
      comment, since spec §7.2 requires "every component score, formula
      version, and inputs" to be recoverable from `signal_evidence`, and
      a future milestone will need to know what v1 actually computed vs.
      what the full formula eventually does).
  - `packages/domain/src/signal-score.ts`'s `computeNewJobScore()` +
    `computeFreshness()`. V/A/B are fixed at a documented neutral
    constant (0.5, not 0) so they contribute a stable baseline rather
    than silently zeroing out 55% of the formula's weight for every
    `new_job` signal — the header comment explains why 0.5 was chosen
    over 0 and flags this as the exact thing a future milestone (real
    volume/acceleration baselines) must replace. Q is real (fed directly
    from `classification_confidence`, not a placeholder). P is always 0
    in v1 (no penalty inputs implemented yet, and a real P needs
    source-reliability history this milestone doesn't have).
  - **Store `score_version`** (already a column) and bump it if the
    formula's inputs change later — spec §7.2: "Scores must be
    recomputable from persisted observations."
  - Done: `SCORE_FORMULA_VERSION = "v1"` exported and threaded through
    `ScoreResult.formulaVersion`, meant to be persisted as `signals.score_version`.
  - Verify: `packages/domain/src/signal-score.test.ts` (9 tests) — 3
    hand-computed cases spanning the freshness decay curve (d=0, d=14,
    d=60) with the exact arithmetic shown in comments, plus boundary
    tests (never exceeds 100, never below 0) and a test asserting the
    v1 neutral constant is exactly 0.5 for V/A/B. All hand-computed
    expected values matched on first run — no arithmetic bugs found.
- [x] Wire into the ingest-consumer's post-upsert step (Milestone D):
      new job upserted → lifecycle says `active` and it's a first-seen →
      classification says role matched → create/refresh signal + evidence
      row.
  - Verify: unit tests for the score formula against hand-computed
    expected values (at least 3 cases spanning the freshness decay
    curve); `pnpm --filter @hiring-signals/db typecheck`.
  - **Status (2026-07-28): done.** Wired inside
    `apps/api/src/jobs/ingest-consumer.ts`'s per-job loop (Milestone D):
    on a `new_job`/`reopened_job` lifecycle candidate, `classifyJob()`
    runs, and if `autoClassified` is true, `findActiveSignal` →
    `createSignal`/`refreshSignal` → `appendSignalEvidence` fires using
    `computeNewJobScore()`'s result. Covered end-to-end by
    `apps/api/src/jobs/ingest-consumer.test.ts`'s happy-path test. This
    only became exercisable after a real bug fix to `classifyJob`
    (`packages/domain/src/classification.ts`, 2026-07-28 commit) — the
    prior implementation made `autoClassified: true` mathematically
    unreachable for any input, which would have made this wiring
    silently dead code even though it was written correctly. See that
    commit and `packages/domain/src/classification.test.ts`'s new
    regression test.

---

## Milestone D — Scheduler, queue consumer, source-management scripts (`apps/api` + `infrastructure/scripts`)

Spec: §5.1 (flow), §5.2 (cadence math — already fully specified, just
needs implementing), §13.2 (middleware order), §13.3 (queue message,
idempotency), §13.4 (failure handling table), §13.5 (source management
is ops-only, no HTTP admin surface).

This is the milestone that turns Milestones A–C from "code that exists"
into "a running pipeline." Depends on all three being done first.

- [x] `apps/api/src/jobs/scheduler.ts` (currently an empty
      `TODO(Phase 1)` stub):
  - Query `getDueSources` (Milestone A) for sources where
    `enabled = 1 AND next_poll_at <= now()`.
  - For each due source, enqueue one `IngestMessage` (domain schema
    already exists: `packages/domain/src/ingest-message.ts`) with
    deterministic jitter derived from `source_id` (spec §5.2's explicit
    requirement — "so sources don't all fire in the same cron tick").
    A stable hash of `source_id` mod some spread window is enough; no
    need for a crypto-strength hash here, just determinism.
  - **Must only enqueue, never fetch** (spec §5.1, §5.2's closing
    paragraph is explicit and repeated for emphasis — this is the one
    rule most likely to get violated by "just inline the fetch, it's
    only for testing"). Enforce this by *not* importing any adapter's
    `fetchBoard` into this file at all — if the import isn't there, it
    can't be called.
  - Bound the number of sources processed per invocation so the 15-min
    cron (spec §13.1 wrangler.toml example) can't blow Workers' Free-tier
    CPU-per-invocation limit if the due-source count spikes; a `LIMIT` on
    the `getDueSources` query is enough, remaining due sources get picked
    up next tick.
  - Verify: unit test with a fake `D1Client`/queue double asserting (a)
    only due sources enqueue, (b) jitter is deterministic for a given
    `source_id` across two calls, (c) nothing is fetched.
  - **Status (2026-07-28): done.** `apps/api/src/jobs/scheduler.test.ts`
    (4 tests) confirms all three: only `getDueSources` rows enqueue,
    jitter is deterministic per `source_id` across two calls, and no
    adapter/fetch import exists in the file (enforced structurally, not
    just by test — grep confirms it). `pnpm --filter @hiring-signals/api
    typecheck`/`lint` clean.

- [x] `apps/api/src/jobs/ingest-consumer.ts` (currently
      `console.log("ingest_stub", ...)` + ack):
  - Full pipeline per spec §5.1: fetch (adapter's `fetchBoard`) → validate
    (adapter's Zod schema, inside `normalize()`) → normalize → upsert jobs
    (Milestone A) → insert observations (Milestone A) → lifecycle
    transition (Milestone B) → classification (Milestone B) → signal
    generation (Milestone C) → write `source_runs` metrics (Milestone A)
    → cache invalidation for the facets KV cache (`apps/api/src/routes/
    facets.ts` already has a 60s KV cache — bust or let it expire
    naturally; expiring naturally is simpler and the spec doesn't
    require sub-60s propagation, don't add invalidation complexity the
    spec doesn't ask for).
  - **Idempotency is the hard requirement here** (spec §13.3: "A retry
    for the same sourceId + runId must not create duplicate observations
    or duplicate signals"). The natural key is already unique
    (`jobs(source_id, external_job_id)`, and `job_observations` should
    key off `(job_id, source_run_id)` — check whether that needs its own
    UNIQUE constraint added in a new migration, since migration 0001 as
    written doesn't have one on `job_observations`; if a retry can insert
    a second observation row for the same `(job_id, source_run_id)`,
    that's a bug to fix as its own migration task, not silently worked
    around in application code). Use the `runId` to make `source_runs`
    writes idempotent too (upsert or check-before-insert on `id`).
  - Failure handling per spec §13.4's table — implement each row as its
    own branch, don't collapse them into one generic catch-and-retry:
    429/Retry-After, transient 5xx/timeout (capped exponential backoff),
    4xx config issue (mark source degraded, no hammering), schema
    mismatch (already surfaces as `GreenhouseSchemaError` from the
    adapter — catch it specifically, store the safe diagnostic, don't
    let it fall through to a generic 500-equivalent), anti-bot/CAPTCHA
    (disable source automatically), D1/KV transient error (retry,
    preserve idempotency).
  - Max retry count from config (spec §13.4 suggests 5); after
    exhaustion, a persistent failure record for human review — a simple
    `source_runs` row with `status = 'failed_final'` plus the diagnostic
    is enough for v1, a formal dead-letter queue can wait for real
    failure volume to justify it.
  - Structured log fields exactly per spec §16.1's list (`request_id`,
    `source_id`, `provider`, `run_id`, `adapter_version`, `http_status`,
    `duration_ms`, `jobs_received`, `jobs_normalized`,
    `signals_created`, `error_code`) — and the same section's explicit
    negative list (never log tokens, cookies, full raw payloads, browser
    PII).
  - Verify: integration-style test using the existing Greenhouse fixture
    (`packages/adapters/src/fixtures/greenhouse-board.json`) through the
    full consumer pipeline against a local D1 (miniflare/`wrangler dev
    --local` or vitest + a D1 test binding, whichever the existing test
    setup in this repo already supports — check `apps/api`'s vitest
    config before picking); assert re-running the same `runId` twice
    produces identical row counts (the idempotency requirement, made
    concrete as a test instead of just a comment).
  - **Status (2026-07-28): done.** `apps/api/src/jobs/ingest-consumer.ts`
    is fully implemented (not a stub). Verified with
    `apps/api/src/jobs/ingest-consumer.test.ts` (10 tests) — deviated
    from this item's original verify plan of miniflare/`wrangler dev
    --local` against the real Greenhouse fixture: used a hand-built
    in-memory `D1Client` fake instead (SQL-substring-routed, same style
    as `packages/db/src/signals-write-repo.test.ts` and
    `scheduler.test.ts`), since that's the pattern already established
    elsewhere in this repo and avoids a slower/flakier local-D1
    dependency for CI. A fake adapter (not the real Greenhouse fixture)
    supplies a job whose title+department both phrase-match, so the
    happy-path test exercises real auto-classification and signal
    creation end-to-end. Covers: happy path (upsert → observation →
    lifecycle → classification → signal creation), idempotency (same
    `runId` retried twice produces identical row counts — the concrete
    assertion this item's verify line asks for), lifecycle transitions
    across multiple runs (active → possibly_closed on second absence,
    spec §5.4), and every §13.4 failure branch (missing source, 429
    requeue-with-delay, transient 5xx backoff, retry exhaustion →
    `failed_final`, 4xx config error → source disabled, unsupported
    provider, uncaught error → `message.retry()`). This test file was
    originally committed truncated mid-file (syntax error, failing
    `apps/api` typecheck repo-wide) — completed and fixed 2026-07-28.
    `pnpm --filter @hiring-signals/api typecheck`/`lint`/`test` all
    clean; `pnpm -r typecheck`/`lint`/`test` clean across the whole
    workspace (73 tests total).
    A real `wrangler dev --local`/miniflare run against the actual
    Greenhouse fixture is still worth doing before this ships to
    production traffic, same caveat A.1's seed-data verification left
    for D1-specific dialect quirks — the fake double proves the
    consumer's own logic, not D1's behavior under it.

- [x] There is no `apps/api/src/routes/admin.ts` HTTP surface — the app
      has no login and is public/free for anyone, permanently (spec §3,
      §13.5, §14.1). `routes/admin.ts` and its mount in
      `apps/api/src/index.ts` should be deleted, along with
      `protectedWriteTier` in `middleware/anti-abuse.ts` (no remaining
      caller once admin routes are gone) and `lib/http/turnstile.ts`
      (only consumer was `protectedWriteTier`). Remove
      `TURNSTILE_SECRET_KEY` from `apps/api/src/bindings.ts` and any
      `wrangler.toml`/`.dev.vars` reference to it.
  - **Status (2026-07-28): confirmed done** (landed in an earlier
    session's "Remove auth" commit, verified this session rather than
    taken on faith): `apps/api/src/routes/admin.ts` does not exist,
    `grep -rn "protectedWriteTier|turnstile|Turnstile|
    TURNSTILE_SECRET_KEY"` across `apps/api/src`, `lib/http/`, and
    `apps/api/src/bindings.ts` returns nothing, and `lib/http/` contains
    only `circuit-breaker.ts`, `rate-limit.ts`, `security-headers.ts` —
    no `turnstile.ts`.

- [x] Source management ops scripts (spec §13.5) — the sub-item bundled
      under the admin-route-removal bullet above, split out here since
      it's a separate, still-open piece of work (the removal above is
      done; this is not):
  - Source management moves to a local ops script instead (spec §13.5):
    `infrastructure/scripts/manage-sources.ts` (or split into
    `add-source.ts` / `update-source.ts` / `run-ingestion.ts` /
    `source-health.ts` — pick whichever reads cleaner once written, the
    spec doesn't mandate a single file). Each calls the Milestone A repo
    functions (`createSource`, `updateSource`, `getDueSources` /
    `getSourceById`) directly against a `D1Client` constructed from
    `wrangler d1 execute` bindings or a direct D1 HTTP API call — no
    Hono, no route, no network exposure.
  - `createSource` duplicate `(provider, board_token)` still throws
    `DuplicateSourceError` (Milestone A) — the script catches it and
    prints a clear message instead of a route mapping it to `409`.
  - Manual ingestion trigger: the script enqueues one `IngestMessage`
    for a given source immediately (bypasses `next_poll_at`), the same
    message shape the scheduler produces — no rate limit needed since
    it's not reachable over HTTP.
  - Source health: a script that computes the same table spec §16.2
    describes (Source, Company, Provider, Last success, Next poll,
    Jobs, Failures, Status) from `sources` + recent `source_runs` and
    prints it to the terminal — status is derived at read time, not a
    stored field, same reasoning as before, just no longer behind a
    `GET /health` route.
  - Verify: `pnpm --filter @hiring-signals/api typecheck` after the
    deletions (confirm nothing else imports the removed exports); run
    each script once against local D1 (`wrangler d1 execute
    hiring-signals --local`) and confirm it does what it says.
  - **Status (2026-07-28): done.** `infrastructure/scripts/add-source.mjs`,
    `update-source.mjs`, `source-health.mjs`, plus a shared
    `infrastructure/scripts/lib/d1-exec.mjs` helper. Written in plain
    Node (`.mjs`, no TS build step) rather than TypeScript as this
    item's original text suggested — `tsx`/`ts-node` aren't installed
    anywhere in this repo and adding one felt like scope creep for what
    is three CLI wrappers around SQL strings; revisit as `.ts` only if
    the scripts grow real logic worth typechecking.
  - **D1 access approach differs from this item's original plan.**
    `createD1Client` (`lib/d1/client.ts`) takes a native `D1Database`
    binding, which only exists inside a Worker (`wrangler dev` / a
    deployed Worker) — there is no way to construct one from a plain
    Node process, so "call the Milestone A repo functions directly
    against a D1Client" (this item's original text) isn't actually
    achievable outside the Workers runtime. Instead each script shells
    out to `wrangler d1 execute hiring-signals --json` per query
    (`lib/d1-exec.mjs`). This necessarily *duplicates* the SQL shape of
    `sources-repo.ts`'s `createSource`/`updateSource` rather than
    calling those functions — keep both in sync by hand if the schema
    changes; there's no way around this without a build step that
    compiles the workspace package for a plain-Node consumer.
  - **Manual ingestion trigger differs from this item's original plan
    for the same reason.** "The script enqueues one IngestMessage...
    bypasses next_poll_at" (original text) implied pushing directly
    onto `INGEST_QUEUE`, but Cloudflare Queues can only be sent to via a
    live Queue *binding* — `wrangler queues` has no CLI verb to send a
    message, confirmed via `wrangler queues --help`. Reimplementing the
    ~500-line ingest-consumer pipeline inside a script (bypassing the
    queue entirely) was considered and rejected: any drift between two
    copies of that logic would be a silent correctness bug. Implemented
    instead as `update-source.mjs --run-now`, which clears
    `next_poll_at` so the real scheduler cron (or `wrangler dev
    --test-scheduled` for an immediate local trigger) enqueues it
    through the actual, single pipeline. Slower (up to one 15-minute
    cron interval in production) but never diverges from the real code
    path.
  - **New gap found, not yet closed:** there is no `createCompany` in
    `packages/db` (grepped — only `searchCompanies`/`getCompanyBySlug`/
    `getRecentSignalsForCompany` exist; Milestone A's own scope never
    listed a companies-repo write function). `add-source.mjs` therefore
    only attaches a source to an **existing** `company_id` — onboarding
    a brand-new company still requires a manual `INSERT INTO companies`
    via `wrangler d1 execute` until a `createCompany` repo function and
    a corresponding `add-company.mjs`/flag on `add-source.mjs` exist.
    Tracked as a new open item below rather than built silently inside
    this task.
  - **Verified for real, not just typechecked:** applied
    `infrastructure/scripts/seed-local-d1.sql` to a fresh local D1
    instance (companies=20, sources=20, jobs=60, signals=20, matching
    A.1's documented seed exactly), then ran all three scripts against
    it. `source-health.mjs` printed all 20 seeded sources with correct
    company names, job counts, and "healthy" status. `add-source.mjs`
    created a real source row (confirmed via a follow-up `SELECT`), then
    correctly rejected a re-run of the same command with
    `DuplicateSourceError`'s message (exit code 1), and separately
    rejected a nonexistent `--company-id` and an invalid `--provider`.
    `update-source.mjs --disable` and `--run-now` were confirmed via
    `SELECT` to have actually persisted `enabled=0` and
    `next_poll_at=NULL` (not just printed a success message), and
    separately rejected a nonexistent `--id` and a no-flags no-op call.
    Test source cleaned up afterward so local D1 matches A.1's
    documented seed state. One environment note worth recording:
    `wrangler` refuses to run under this machine's default Node
    (v20.20.0, `wrangler` requires >=22) — these scripts (and any future
    `wrangler d1 execute` use) need `nvm use 24.18.0` first, matching
    this repo's own `package.json` `engines` field; the pnpm-workspace
    typecheck/lint/test commands are unaffected since pnpm/tsc/vitest
    don't share wrangler's Node-version check.
    `pnpm -r typecheck`/`lint` re-ran clean after adding these files
    (they sit outside all workspace packages, as expected for plain
    ops scripts, so they don't participate in either check — confirmed
    rather than assumed).

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
`normalize`), same fixture-test pattern as `greenhouse.ts`/
`greenhouse.test.ts`. One PR/commit per adapter, not a batch — keeps
review scoped and lets a bad fixture assumption in one provider get
caught before it's copy-pasted into the next nine.

- [x] `lever` — `packages/adapters/src/lever.ts` + fixtures + tests
  - **Status (2026-07-28): done.** Public, unauthenticated Postings API
    (`GET https://api.lever.co/v0/postings/{site}?mode=json`) verified
    live before writing the schema, per spec §21 — fetched
    `github.com/lever/postings-api`'s own README for the current field
    list, then hit `https://api.lever.co/v0/postings/leverdemo?mode=json`
    directly and confirmed the real response matches. This surfaced
    three shape details training data alone wouldn't have guaranteed
    were still current: the list response is a **bare top-level array**
    (not a `{ jobs: [...] }` envelope like Greenhouse), `country` can be
    **entirely absent** (not just `null`), and `categories.location`/
    `categories.department` are independently optional — a real posting
    in the fetched sample had only `categories.team`.
  - `leverPostingSchema`/`leverBoardSchema` (Zod) validate the array-of-
    postings shape; `LeverSchemaError` thrown on validation failure,
    same non-silent-empty-array reasoning as `GreenhouseSchemaError`.
  - Location mode: Lever exposes a structured `workplaceType` field
    (`unspecified`/`on-site`/`remote`/`hybrid`) — trusted directly when
    set to a real value (spec §6.4 prefers structured data over
    free-text inference where available), falling back to
    `inferLocationMode` on the location string only when
    `workplaceType` is `"unspecified"` (Lever's own "we don't know"
    value) or absent. `resolveLocationMode()` documents this choice
    inline.
  - Timestamps: Lever's list API exposes only `createdAt` (epoch ms) —
    no separate "last updated" field — so it's used for both
    `postedAt` and `updatedAt`. Documented inline in `normalize()` as a
    real data-availability gap specific to this provider, not an
    oversight, since a future milestone touching lifecycle timing for
    Lever sources needs to know that.
  - `packages/adapters/src/fixtures/lever-board.json` built from the
    real `leverdemo` response fetched during verification (trimmed to 4
    postings, company/content details replaced with placeholders) —
    covers `workplaceType: "remote"`, `workplaceType: "hybrid"`,
    `workplaceType: "unspecified"` with a plain-city location string,
    and a posting with no `categories.location` at all (only `team`,
    `allLocations: []`, and no `country` key). `lever-board-malformed.json`
    for the schema-error case.
  - `lever.test.ts` (13 tests): id/URL passthrough, `workplaceType`
    trusted over free-text inference (`remote` and `hybrid` cases),
    free-text fallback when `workplaceType` is `unspecified`,
    `allLocations[0]` fallback when `categories.location` is absent,
    `department` falling back to `team`, `department` preferred over
    `team` when both present, `createdAt` → ISO-8601 conversion for
    both `postedAt`/`updatedAt`, missing `country` handled without
    throwing, `LeverSchemaError` on a malformed posting and on a
    non-array payload, provider identity.
  - Registered in `registry.ts`'s `ADAPTERS` map and re-exported from
    `index.ts`, same as `greenhouse.ts`.
  - **One real bug caught and fixed before this was called done, not
    after:** the test file was originally written in two chunked
    writes; the first chunk's `describe("leverAdapter.normalize", ...)`
    block was closed with a stray `});` that put every test added in
    the second chunk outside any `describe` block, which
    `tsc --noEmit` caught immediately (`TS1128: Declaration or
    statement expected`) rather than silently passing. Fixed by
    removing the premature closing brace. Separately, the `createdAt`
    → ISO timestamp test's expected value was hand-computed wrong on
    the first pass (off by 4 hours) — caught by actually running
    `node -e "console.log(new Date(1753000000000).toISOString())"`
    before trusting the assertion, not by mental arithmetic.
  - **Verified for real:** `pnpm --filter @hiring-signals/adapters
    typecheck`/`lint`/`test` clean (30/30 tests, up from 17 — the 13 new
    Lever tests plus the existing 12 Greenhouse + 5 location tests);
    `pnpm -r typecheck`/`lint`/`test` clean across all 5 workspace
    projects (90 tests total, only the 3 pre-existing
    `consistent-type-imports` warnings in `apps/api`).
  - `infrastructure/scripts/add-source.mjs`'s inlined `ATS_PROVIDERS`
    list (Milestone E's own open item below) already included `"lever"`
    — no change needed there.
- [ ] `ashby`
- [ ] `smartrecruiters`
- [ ] `workable`
- [ ] `recruitee`
- [ ] `personio`
- [ ] `teamtailor`
- [ ] `jazzhr`
- [ ] `breezy`
- [ ] `bamboohr`

For each: confirm the provider's public, unauthenticated board API is
still live and documented *before* writing the schema (spec §21: "Never
invent API endpoints ... Verify source contracts first") — don't assume
last-known-good API shapes from training data are current; check the
provider's own developer docs.

- [ ] Update the ops source-management script's provider-enum usage as
      each adapter below lands. Milestone D's `add-source.mjs`
      (`infrastructure/scripts/`) is a plain `.mjs` script (not
      TypeScript, so it can't import `@hiring-signals/domain`'s
      `ATS_PROVIDERS` directly — see Milestone D's status note) and
      instead inlines its own copy of the 11-provider list with a
      comment pointing back to `packages/domain/src/providers.ts` as the
      source of truth. Update that inlined copy by hand each time an
      adapter lands here — there's no automated sync between the two.
- [ ] Update AGENTS.md's roadmap status and this file as each adapter
      lands.

---

## Milestone F — Dashboard UI (Phase 2, `apps/web`)

Spec §11 (Minimal Brutalist visual system), §12 (Next.js requirements),
§10 (UX spec — route map, filters, signal cards, detail view, empty/
loading/error states).

Not detailed task-by-task here yet — this file's first pass focused on
the write-path (Milestones A–E) since that's what was in flight when
this document was created. Expand this milestone into the same
level of task detail before starting it; don't start UI work directly
off the one-line spec references above.

---

## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §14.1 (security controls — no auth is required or wanted; the app
is public/free permanently), §16.2/§16.3 (ops health script output,
alerts — the *alerting* layer on top of Milestone D's ops scripts), §18
(CI/CD), §19 (acceptance criteria).

Also not detailed task-by-task yet — expand before starting. No auth
item remains here: access model and tenancy are settled (spec §22
preamble) — single-tenant, public, no login, ever.

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
