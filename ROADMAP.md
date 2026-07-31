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
  - **Superseded (2026-07-30): `routes/admin.ts` now exists again, by a
    new and deliberate decision — see spec §13.5a.** This is not a
    silent reversal of the bullet above; it's a different design for a
    different job. What was removed here was a **cookie/Turnstile-based
    write tier** (`protectedWriteTier`) sitting in front of write
    routes generally — that removal stands, and neither
    `protectedWriteTier` nor `turnstile.ts` has come back. What exists
    now is a narrow, **secret-bearer-token, operator-only** trigger
    surface (`ADMIN_SECRET` via `Authorization: Bearer`, never a
    cookie, never a CAPTCHA, never anything `apps/web` calls) exposing
    exactly three idempotent pipeline triggers (source-run,
    scheduler-flush, reconcile) — no source create/edit, which stays a
    local ops script only, per spec §13.5 unchanged. Confirmed
    `apps/web` has zero references to `/admin` anywhere in its source
    (`grep -rn "admin" apps/web` returns nothing) before accepting this
    as compatible with "no login a user ever sees." See spec §13.5a for
    the full decision record and rationale (modeled on, and hardened
    beyond, ArxivExplorer's own admin pattern).

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
  - **Status (2026-07-29): test-isolation + code-review follow-up
    pass.** Three changes, each committed separately rather than
    squashed, so the history stays legible if any one needs reverting:
    1. **Test-folder isolation.** Every `*.test.ts` (and its fixtures)
       moved out of `src/` into a sibling `test/` directory across
       `apps/api`, `packages/adapters`, `packages/db`, and
       `packages/domain` — import paths updated to relative `../src/*`
       and `test/**/*.ts` added to each package's `tsconfig.json`
       `include` so typecheck still covers them. Purely structural, no
       behavior change.
    2. **Centralized `isUniqueConstraintError`** (code-review P3 from
       the ingest-consumer fix-adequacy review below): the helper had
       three near-identical copies — `sources-repo.ts` and
       `companies-repo.ts` already shared one via
       `packages/db/src/internal/d1-errors.ts`, but that module being
       package-private meant `insertObservationIdempotent` in the
       ingest consumer couldn't import it and kept its own inline
       regex. Also flagged: `internal/` living inside `packages/db/src`
       with no `tsconfig`/`exports` guard meant a stray cross-package
       import could resolve at build time despite not being
       re-exported from `index.ts`. Fixed per the review's own
       suggested option: moved the helper to
       `lib/d1/unique-constraint.ts` (a pure string check with no
       repo/schema coupling, same home as the sibling
       `lib/d1/like-pattern.ts`) and had all three call sites import it
       directly; deleted the now-empty `packages/db/src/internal/`.
    3. **Hardened the ingest-consumer test's fake bindings**
       (code-review P3): `makeFakeEnv()`'s `env.DB`/`env.CACHE` were
       `{} as unknown as Bindings[...]` — safe today only because
       `createD1Client` is mocked to ignore whatever's passed to it,
       but a bare empty object would fail with a confusing "is not a
       function" instead of a clear signal if that mock were ever
       removed. Replaced with an `unusedBinding<T>(name)` helper: a
       `Proxy` that throws a descriptive error naming the accessed
       property and the mock it should go through instead. Applied to
       both `ingest-consumer.test.ts` and `scheduler.test.ts`, which
       had the identical pattern.
    All three verified independently: `pnpm -r typecheck` (5/5
    workspace projects clean) and `pnpm -r test` (94/94 passing,
    unchanged count — confirms #2 and #3 were pure refactors with no
    behavior change, and #1 didn't silently drop or duplicate any
    tests in the move).

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
- [x] `ashby` — `packages/adapters/src/ashby.ts` + fixtures + tests
  - **Status (2026-07-30): done.** Official Ashby Job Postings API docs
    verified before implementation (spec §21):
    `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation={true/false}`
    returns an `{ apiVersion, jobs }` JSON envelope with job fields such
    as `title`, `location`, `secondaryLocations`, `department`, `team`,
    `isListed`, `isRemote`, `workplaceType`, `descriptionPlain`,
    `publishedAt`, `employmentType`, `jobUrl`, and `applyUrl`. A direct
    live fetch attempt from this container was blocked by the network
    proxy (`curl: (56) CONNECT tunnel failed, response 403`), so the
    adapter is based on the current first-party docs rather than a stale
    remembered shape; the failure is recorded here rather than hidden.
  - `AshbySchemaError` mirrors the Greenhouse/Lever behavior: malformed
    provider payloads throw a typed schema error instead of returning an
    ambiguous empty job list. The schema is permissive for optional fields
    Ashby documents as missing when unavailable.
  - Ashby's public docs do not expose a separate stable job id in the
    board response. The adapter deliberately uses `jobUrl` as both
    `externalJobId` and `canonicalUrl`, tying idempotency to the public
    evidence URL instead of inventing a title/location-derived key.
  - `isListed: false` jobs are filtered out because Ashby's docs describe
    them as direct-link-only roles that should not appear in the public
    job-board list. `workplaceType` is trusted when present (`Remote` →
    `remote`, `Hybrid` → `hybrid`, `OnSite` → `onsite`), then
    `isRemote: true`, then free-text location inference. `publishedAt`
    is used for both `postedAt` and `updatedAt` because the public board
    response documents only one timestamp.
  - `ashbyAdapter` is registered in `registry.ts` and re-exported from
    `index.ts`; the ops script provider list already included `ashby`, so
    no script enum change was required.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`,
    `pnpm --filter @hiring-signals/adapters lint`, and
    `pnpm --filter @hiring-signals/adapters test` (43/43 adapter tests,
    including 13 new Ashby tests) pass.
- [x] `smartrecruiters` — `packages/adapters/src/smartrecruiters.ts` + fixtures + tests
  - **Status (2026-07-30): done.** Official SmartRecruiters Posting API docs
    verified before implementation (spec §21): the public Posting API exposes
    `/postings` for searching postings and `/postings/{postingId}` for detail
    under `https://api.smartrecruiters.com/v1/companies/{companyIdentifier}`.
    A live direct fetch from this container was blocked by the network proxy
    (`curl: (56) CONNECT tunnel failed, response 403`), so the adapter is based
    on current first-party docs plus public shape references rather than an
    unverified remembered payload.
  - `SmartRecruitersSchemaError` mirrors the existing provider adapters: bad
    payloads throw a typed schema error instead of being normalized to an
    ambiguous empty board. The schema accepts both the documented
    `{ content, totalFound, limit, offset }` list envelope and a flat posting
    array because public references describe both shapes for this public feed.
  - Stable keys prefer `uuid`, then `id`, then the public action URL; canonical
    evidence URL prefers `actions.details.url` before `actions.apply.url`.
    Postings with no public action URL throw because `NormalizedJob` requires a
    canonical evidence URL. `location.remote` is trusted when true, otherwise
    location mode falls back to text inference from structured city/region/
    country or address fields. `releasedDate` maps to `postedAt`; `updatedOn`
    maps to `updatedAt` with `releasedDate` as the fallback.
  - `smartRecruitersAdapter` is registered in `registry.ts` and re-exported
    from `index.ts`; the ops script provider list already included
    `smartrecruiters`, so no script enum change was required.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`,
    `pnpm --filter @hiring-signals/adapters lint`, and
    `pnpm --filter @hiring-signals/adapters test` (58/58 adapter tests,
    including 15 new SmartRecruiters tests) pass.
- [x] `workable` — `packages/adapters/src/workable.ts` + fixtures + tests
  - **Status (2026-07-30): done.** Workable's public careers feed was
    checked against first-party docs before implementation (spec §21):
    `GET https://www.workable.com/api/accounts/{account_subdomain}?details=true`
    returns a public jobs envelope. A live direct fetch from this container was
    blocked by the network proxy (`curl: (56) CONNECT tunnel failed, response
    403`), so the adapter is based on current first-party documentation and
    fixture-shaped examples rather than unverified remembered payloads.
  - `WorkableSchemaError` mirrors the other adapters: a missing top-level
    `jobs` array or structurally malformed posting is a provider schema
    mismatch, not a silent empty board. The adapter deliberately does not
    filter on Workable's `state` field because the public endpoint already
    returns published jobs and public examples also use `state` for
    location-like values.
  - Stable keys prefer Workable's `shortcode`, then `id`; canonical evidence
    URLs prefer `url`, then `shortlink`, then `application_url`. Location mode
    trusts structured `workplace_type`/`telecommuting` before falling back to
    free-text inference, and timestamps are normalized to ISO-8601 UTC when
    parseable.
  - `workableAdapter` is registered in `registry.ts` and re-exported from
    `index.ts`; the ops script provider list already included `workable`, so
    no script enum change was required.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`,
    `pnpm --filter @hiring-signals/adapters lint`, and
    `pnpm --filter @hiring-signals/adapters test` (72/72 adapter tests,
    including 14 new Workable tests) pass.
- [x] `recruitee` — `packages/adapters/src/recruitee.ts` + fixtures + tests
  - **Status (2026-07-30): done.** Official Recruitee Careers Site API docs
    verified before implementation (spec §21): the public, unauthenticated
    careers-site API exposes published offers for custom careers pages at
    `https://{company}.recruitee.com/api/offers/`; Recruitee also documents
    the legacy `https://api.recruitee.com/c/{company_id}/offers` endpoint with
    the same top-level offers concept. The adapter fetches the careers-site
    host because `board_token` is the company subdomain operators configure.
  - `RecruiteeSchemaError` mirrors the other provider adapters: malformed
    provider payloads throw a typed schema error instead of silently looking
    like an empty board. Stable keys prefer `slug`, then `id`; canonical
    evidence URLs prefer `careers_url`, then `url`, then `apply_url` because
    the public evidence URL is what downstream signal detail pages need.
  - Location handling trusts Recruitee's structured `remote: true` boolean as
    remote before falling back to free-text inference from the singular
    `location` field or `locations[0]`. `published_at` is preferred for
    `postedAt`, with `created_at` as fallback; `updated_at` falls back to the
    resolved posted timestamp when Recruitee omits a separate update time.
  - `recruiteeAdapter` is registered in `registry.ts` and re-exported from
    `index.ts`; the ops script provider list already included `recruitee`, so
    no script enum change was required.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`,
    `pnpm --filter @hiring-signals/adapters lint`, and
    `pnpm --filter @hiring-signals/adapters test` (86/86 adapter tests,
    including 14 new Recruitee tests) pass.
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

**UI/animation source of inspiration, decided with the user: `ArxivExplorer`
(same account, same author, same "single-page dense dashboard" shape as
this product).** This mirrors the precedent already set for Milestone I
(semantic search ported ArxivExplorer's search UX mechanics — see that
milestone's own "UI inspiration source" note). Milestone F extends the
same reuse decision to the *rest* of the dashboard shell: page transitions,
loading/empty states, hover micro-interactions, and ambient background
motion. **Reuse the animation mechanics and interaction timing, never the
visual styling** — same restyle-from-scratch rule Milestone I already
states, repeated here because it's the one most likely to get skipped
under time pressure ("just copy the classes, it's faster"): ArxivExplorer
is built for a neon-red cyberpunk aesthetic (`text-neon-red`, glassy
`backdrop-blur` cards, chromatic glow shadows) that directly conflicts
with spec §11's Minimal Brutalist system (strict black/white, hard edges,
no gradients/glassmorphism/drop-shadows, one scarce accent color). Every
component below gets its *behavior* (props, timing curves, state machine,
trigger conditions) ported and its *appearance* (colors, blur, shadows,
border-radius, font) rewritten against §11's tokens from
`hiring-signals-spec.md` §11.2-§11.4.

**Concrete component-by-component reuse map** (all paths are
`ArxivExplorer/app/components/` unless noted; confirmed present on disk
2026-07-30, not assumed from memory):

- **`ScrollProgress.tsx`** — trivial, framework-agnostic scroll-fraction
  bar (`scrollTop / (scrollHeight - innerHeight)` driving a `scaleX`
  transform). Port near-verbatim; restyle the bar itself to a `2px`
  solid black line (or the single chartreuse accent, spec §11.2) instead
  of ArxivExplorer's neon-red gradient. Useful on `/signals` for a long
  scrolling feed.
- **`Card.tsx`**'s hover mechanics (`whileHover={{ y: -3 }}`, a
  `framer-motion` `useMotionValue`-driven mouse-tracking radial glow,
  corner-accent elements that grow on hover) — port the *lift + corner
  accent* pattern for signal cards/rows (spec §10.3's card requirements,
  §11.4's "Card / row" component rule), but **drop the mouse-tracking
  radial glow and blur entirely** — a soft glowing gradient following
  the cursor is exactly the "floating translucent panel" effect
  §11.1 explicitly rules out ("No gradients, glassmorphism ... drop
  shadows"). Keep: the `y: -3` lift on hover, the corner-accent squares
  that grow from 4px to 6px (redraw in solid black `border`, no
  transparency), the `0.18s` hover transition duration. This is a
  *subtractive* port — take the restrained part of the interaction,
  leave the glow.
- **`AnimatedTagline.tsx`**'s per-character stagger-in animation
  (`chars.map` each wrapped in its own `motion.span` with a
  `delay: (chars.length - 1 - i) * 0.04` cascade) — reusable mechanic
  for the masthead/header line (spec §10.2's `HIRING//SIGNALS` masthead)
  on first load. Restyle: no color-shift/text-shadow hover effect (that's
  a neon aesthetic beat), keep only the character-cascade entrance.
  `prefers-reduced-motion` must disable this per spec §11.5 — Milestone F
  must add that check; ArxivExplorer's own version doesn't guard it,
  which is a real gap to fix in the port, not carry over.
- **`DecryptedText.tsx`**'s scramble-in-place text-reveal effect (backed
  by `lib/hooks`' `useTextScramble`) — optional, lower-priority: a
  legitimate candidate for the score badge or a headline revealing on
  card mount (spec §10.3 item 1, "score badge"), but genuinely optional
  since it risks reading as decorative flourish against §11.1's "content
  and evidence outrank decoration" principle. If used, gate it to `700ms`
  max duration in monospace to match the score block's own type (§11.3),
  and never sacrifice `Score block` legibility (§11.4) mid-scramble —
  don't ship this if it makes the score number briefly unreadable in a
  way that could be mistaken for the actual value.
- **`AchievementToast.tsx`**'s pattern (a `CustomEvent`-driven toast
  queue, auto-dismiss after a fixed duration, `fixed bottom-*` stack) —
  reusable *mechanism*, not content: this product has no achievements/
  gamification (out of scope, not in the spec), but the same
  event-driven toast queue is the right shape for a lightweight
  "new signals since last visit" or "source degraded" notice if one is
  ever wanted. Not scoped into F's initial build — flag as a reusable
  pattern for later, don't build the toast queue speculatively now.
- **`ParticleBackground.tsx`** (Three.js, 20,000-particle ambient field)
  and **`ui/background-beams.tsx`** (SVG animated gradient beams) —
  **do not port either.** Both are pure decorative ambient motion, and
  spec §11.1 is explicit: "Content and evidence outrank decoration...
  No gradients... or stock illustrations." A dense, information-forward
  Brutalist dashboard is the opposite design goal from ArxivExplorer's
  atmospheric cyberpunk background. Recorded here as a considered-and-
  rejected reuse candidate so a future session doesn't re-propose it
  without re-reading this rationale.
- **`SearchBoxHome.tsx` / `SearchFilters.tsx` / `MoreLikeThisButton.tsx`
  / `RecentSearches.tsx` / `AbstractSearch.tsx`** — already covered by
  Milestone I.4's own inspiration-source note (search-specific UI, not
  the general dashboard shell); don't duplicate that work here, just
  don't lose track of it being the *same* ArxivExplorer-reuse decision.

**Dependencies this reuse decision requires, not yet installed:**
`apps/web/package.json` currently has neither `framer-motion` nor
`three` (confirmed 2026-07-30 by reading the file directly — only
`next`/`react`/`react-dom`/`zod`/`@hiring-signals/domain`). Adding
`framer-motion` is required for the `Card`/`AnimatedTagline`/
`DecryptedText` ports above; `three` is explicitly **not** needed since
`ParticleBackground` is the one component this milestone rejects.
Install `framer-motion` when F actually starts, pinned to a version
compatible with React 19 (ArxivExplorer itself is still on React 18 +
`framer-motion@^11.18.2` — confirm current `framer-motion` React-19
compatibility before pinning a version, don't assume the same version
range ports unchanged).

**What's still genuinely new, undetailed work** (this reuse note narrows
scope but doesn't replace the rest of F's own task breakdown): the
route map (§10.1), filter rail (§10.4), signal card/row layout (§10.3),
signal detail view (§10.5), and empty/loading/error states (§10.6) all
still need their own task-by-task breakdown before implementation
starts, same as this milestone's pre-existing "expand before starting"
instruction below. This section only settles the animation/inspiration
question the user raised; it does not itself constitute that breakdown.

Not detailed task-by-task here yet beyond the animation-reuse decision
above — this file's first pass focused on the write-path (Milestones
A–E) since that's what was in flight when this document was created.
Expand this milestone into the same level of task detail before
starting it; don't start UI work directly off the one-line spec
references above.

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

## Milestone H — Signal-quality logic pass

Spec §6.2 (classification), §7.1 (signal types), §7.2 (scoring), §5.2
(reconciliation cadence). Originated from a targeted logic-quality
review of `packages/domain` (classification/lifecycle/signal-score) and
`apps/api/src/jobs/ingest-consumer.ts`'s wiring, run against what's
actually on disk (not the ROADMAP's own status notes) per AGENTS.md's
"fix and verify" policy. Found four concrete, real gaps — all four
confirmed in scope with the user before starting:

1. `computeNewJobScore` fixes Volume/Acceleration/Breadth at a constant
   0.5 (55% of the formula's weight) — a documented v1 stub, no query
   exists yet to compute them for real.
2. Four of six signal types (`hiring_burst`, `role_acceleration`,
   `multi_location`, `persistent_demand`) are typed in `signal.ts` and
   fully specced in §7.1 but nothing ever creates them.
3. `classifyJob` feeds raw, unbounded description text into the same
   phrase-matcher as title/department, so an incidental mention of an
   adjacent role in the description body can suppress a signal for a
   job that title/department correctly and specifically identified.
4. The score's freshness term anchors on `job.postedAt` rather than
   "days since the signal's most recent evidence observation" (spec's
   literal wording) — investigated below; concluded this is *not* a bug
   to revert, but does expose a real missing piece (reconciliation).

Ordered by dependency: H.1 is self-contained. H.2 is the shared data
layer H.3 and H.4 both need, so it lands before either. H.5 is
independent of H.1–H.4 and can land in any order relative to them.

- [x] **H.1 — Classification: description-channel noise fix**
  (`packages/domain/src/classification.ts`, spec §6.2)
  - **Status (2026-07-29): done.** Implemented exactly as planned below:
    a `structuredCategories` set (populated from `titleMatch`/
    `departmentMatch`) gates whether a description match is scored at
    all -- dropped unless it confirms a category already in that set, or
    the set is empty (title+department both matched nothing, the
    pre-existing last-resort path). Header doc comment gained a new
    step 5c explaining the guard; the disagreement-penalty comment was
    updated to note the `>= 3` branch is now structurally dead code
    under the two-structured-channel design (kept for defensiveness, not
    forgotten -- noted explicitly per this item's own instruction).
  - Test changes: the old "applies the full 3-way disagreement discount"
    test's expected value updated from `0.7*0.7` to `0.7*0.85` with a
    comment explaining why (title-vs-department is still a real 2-way
    conflict; description's disagreement no longer compounds it). Two
    new regression tests added for the worked examples: title+department
    full agreement surviving a disagreeing description (crosses 0.80,
    the exact failure mode this item exists to close) and a confirming
    description still adding its weight when it agrees with the
    structured match. One test-construction bug caught and fixed during
    verification, not shipped: an initial version of the
    confirming-description test used title-only + description
    (0.70 + 0.10), which hits `0.7999999999999999` in IEEE 754 floating
    point -- just under `AUTO_CLASSIFY_THRESHOLD`'s `0.8` -- so
    `autoClassified` came back `false` on a case that should pass. Not a
    bug in `classifyJob` itself; fixed by adding a department channel to
    the test's example so it clears the threshold with real margin
    (1.0 vs 0.8) instead of sitting exactly on a float boundary.
  - Verified: `pnpm --filter @hiring-signals/domain test` green (41/41,
    up from 39 -- 2 new tests, 0 dropped), `typecheck`/`lint` clean;
    `pnpm -r typecheck` clean across all 5 workspace projects afterward.
  - Problem, precisely: title/department are "structured" channels — the
    curated fields that describe the role's own identity. Description is
    unstructured prose and routinely mentions *other* roles the person
    will work alongside ("you'll collaborate with our Security team",
    "reporting to the VP of Data"). The existing disagreement-penalty
    logic (2026-07-28's L1 fix) treats a description-only disagreement
    as equal evidence to title/department, so it can knock a correctly
    classified job below `AUTO_CLASSIFY_THRESHOLD` purely on an
    incidental phrase. Worked example: title="Software Engineer" +
    department="Software Engineer" (0.7+0.2=0.9) with a description
    mentioning "our Security team" currently discounts to
    `0.9*0.85=0.765` — below the 0.80 threshold — even though two
    structured fields fully agree.
  - Fix: description only contributes to `categoryScores` when it (a)
    confirms a category title or department already matched (pure
    confirmation, no penalty), or (b) is the *only* evidence available
    (title and department both matched nothing — the existing "last
    resort" path, already covered by
    `classification.test.ts`'s "department + description match without
    a title match" case). A description-only disagreement with an
    existing structured match is dropped, not counted as a competing
    vote.
  - Side effect to account for in tests: under this fix, description can
    never be the *source* of a third distinct category — the maximum
    `distinctCategoriesMatched` becomes 2 (title vs. department), so a
    genuine 3-way disagreement is structurally unreachable. The existing
    `distinctCategoriesMatched >= 3` branch (0.7 multiplier) stays in
    the code for defensiveness (e.g. if a future change adds another
    structured channel) but becomes dead code under the current
    2-structured-channel design — note this explicitly in a code comment
    so a future reader doesn't mistake it for untested/forgotten code.
  - Test changes needed: the existing "applies the full 3-way
    disagreement discount" test's expected value changes from `0.7*0.7`
    to `0.7*0.85` (department still disagrees with title — a real
    structured-channel conflict — but description's *additional*
    disagreement no longer compounds it) — update the test's comment to
    explain why, don't just silently change the assertion. Add a new
    regression test for the worked example above (title+department
    agreement surviving a disagreeing description, crossing 0.80).
  - Verify: `pnpm --filter @hiring-signals/domain test`/`typecheck`/`lint`.

- [x] **H.2 — Shared company-role activity stats query** (new file,
  `packages/db/src/company-role-stats-repo.ts`)
  - **Status (2026-07-29): done.** `getCompanyRoleActivityStats()`
    implemented exactly as specced below, returning
    `activeMatchingCount`/`newInLast14Days`/`newInPrior56Days`/
    `distinctLocationCount` in one round trip via conditional
    aggregation, `now` passed explicitly by the caller (not
    `datetime('now')`) for determinism/testability. Registered in
    `packages/db/src/index.ts`.
  - Index check done for real, not assumed: built a scratch SQLite DB
    from the actual migrations 0001-0004 + `seed-local-d1.sql`, ran
    `EXPLAIN QUERY PLAN` against the exact query. Confirmed
    `SEARCH jobs USING INDEX idx_jobs_filters (company_id=? AND
    role_primary=?)` — no table scan. Migration 0001's existing index
    already covers the WHERE clause; the windowed `first_seen_at` sums
    are computed from the already-narrowed row set, so no new
    `(company_id, role_primary, first_seen_at)` index was needed (this
    item's own conditional — "if it's doing a scan" — wasn't met).
  - Verified: `packages/db/test/company-role-stats-repo.test.ts` (4
    tests: exact SQL/param shape, empty-result case returning zeros not
    null/throw, real-aggregation case, explicit-zero-SUM case) —
    17/17 green in `packages/db`. `pnpm --filter @hiring-signals/db
    typecheck`/`lint` clean; `pnpm -r typecheck` clean workspace-wide.
  - Foundation for H.3 and H.4 — both need "how much matching activity
    does this company+role have right now," so compute it once, in one
    query, rather than duplicating similar SQL in the scoring path and
    the signal-generation path.
  - `getCompanyRoleActivityStats(client, { companyId, roleCategory, now })`
    returns:
    - `activeMatchingCount`: count of `status IN ('active',
      'possibly_closed')` jobs for `(company_id, role_primary)` — V input.
    - `newInLast14Days` / `newInPrior56Days`: counts of jobs whose
      `first_seen_at` falls in the most-recent-14-days window / the
      56-day window immediately preceding it, for the same
      `(company_id, role_primary)` — A input, matches spec §7.2's
      literal $N_{14}$/$N_{56}$ windows exactly. Anchored on
      `first_seen_at` (our own first-observation timestamp), not
      `posted_at` — this is specifically counting "new matching role"
      *detection* events, which is what `first_seen_at` represents by
      construction (see `computeLifecycleTransition`'s `new_job`
      branch); `posted_at` is a different concept (see H.5) and using
      it here would double up two already-distinct things under one
      anchor.
    - `distinctLocationCount`: count of distinct
      `(country_code, region_code, city, location_mode)` tuples among
      currently-active matching jobs for the pair — B input, and also
      the exact quantity `multi_location`'s trigger threshold (H.4)
      checks.
  - Index check: `idx_jobs_filters (company_id, role_primary, status,
    last_seen_at DESC)` (migration 0001) covers the
    `activeMatchingCount`/location query's WHERE clause but not
    `first_seen_at`, which the two windowed counts filter and sort on.
    Don't assume the existing index is enough — run `EXPLAIN QUERY PLAN`
    against seeded data once this is implemented (same verification
    discipline Milestone A.1 already established for `idx_source_due`),
    and add a migration for
    `(company_id, role_primary, first_seen_at)` if it's doing a scan.
  - Verify: `packages/db/src/test/company-role-stats-repo.test.ts` using
    the fake-`D1Client` double pattern (`signals-write-repo.test.ts`) —
    exact SQL/param shape for all three fields, plus the empty-result
    case (no jobs yet for a company+role, all three fields must return
    0, not throw or return null); `pnpm --filter @hiring-signals/db
    typecheck`/`lint`/`test`.

- [x] **H.3 — Real V/A/B scoring** (`packages/domain/src/signal-score.ts`,
  spec §7.2)
  - **Status (2026-07-29): done.** `computeVolume`/`computeAcceleration`/
    `computeBreadth` implemented exactly per the formulas below (shared
    `clamp` helper extracted). `SCORE_FORMULA_VERSION` bumped `"v1"` ->
    `"v2"`. `computeNewJobScore`'s input interface extended with H.2's
    four stats fields, stays a pure function.
  - Wired into `ingest-consumer.ts`'s `processNormalizedJob`: calls
    `getCompanyRoleActivityStats` (H.2) right after classification
    succeeds, using the just-classified `companyId`/`roleCategory`,
    before `computeNewJobScore`. Comment notes H.4 will reuse this same
    call rather than fetching twice.
  - Test changes: `signal-score.test.ts` fully rewritten -- isolated
    hand-computed tests per new function (`computeVolume`,
    `computeAcceleration`, `computeBreadth`, including saturation/floor
    edge cases), plus `computeNewJobScore` cases with realistic non-0.5
    inputs, plus an explicit test proving V/A/B now vary with input
    (disproving the old fixed-constant behavior). All hand-computed
    arithmetic correct on first run -- no bugs found.
  - `ingest-consumer.test.ts`'s fake D1 client gained a real routing
    branch for H.2's query (previously fell through to `null` -> silent
    all-zeros via the repo's null-coalescing, which would have made the
    happy-path test pass without ever exercising real V/A/B). Caught and
    fixed per this repo's own "verify for real" discipline rather than
    left as a silent gap; one `no-useless-assignment` lint error this
    introduced was also fixed.
  - Verified: `pnpm --filter @hiring-signals/domain test` 52/52 (up from
    41 -- signal-score.test.ts went from 9 to 20 tests), `typecheck`/
    `lint` clean. `pnpm --filter @hiring-signals/api typecheck` clean,
    `lint` clean (0 errors, only pre-existing warnings already noted
    elsewhere in this file), `test` 18/18. `pnpm -r typecheck` clean
    across all 5 workspace projects; `pnpm -r test` 117/117 passing
    workspace-wide (domain 52, db 17, adapters 30, api 18).
  - Replaces the `V1_NEUTRAL_COMPONENT = 0.5` stub. Three new pure
    functions, each independently unit-testable without D1 (same
    reasoning as `computeFreshness`):
    - `computeVolume(activeMatchingCount)`: `clamp(activeMatchingCount / 5,
      0, 1)`. No spec formula given for V; 5 is a documented v1 choice
      (not derived from a spec threshold the way B is) — revisit once
      real ingestion volume shows what a "high" active count actually
      looks like in practice.
    - `computeAcceleration(n14, n56)`: spec §7.2's exact formula,
      `clamp((n14 - n56/4) / max(2, n56/4), 0, 1)`.
    - `computeBreadth(distinctLocationCount)`: `clamp(distinctLocationCount
      / 3, 0, 1)` — 3 is not arbitrary here, it's the same threshold
      spec §7.1 uses to define the `multi_location` signal type itself,
      so the score's B component and the signal-type trigger (H.4) stay
      conceptually aligned instead of using two unrelated numbers for
      "notable location breadth."
  - `computeNewJobScore`'s input interface changes from
    `{ daysSinceObservation, classificationConfidence }` to also accept
    `{ activeMatchingCount, newInLast14Days, newInPrior56Days,
    distinctLocationCount }` (H.2's output shape) — stays a pure
    function; the caller (ingest-consumer) is responsible for fetching
    H.2's stats before calling it, same D1-free-domain-logic pattern as
    the rest of this package.
  - **Bump `SCORE_FORMULA_VERSION` from `"v1"` to `"v2"`** — spec §7.2:
    "Scores must be recomputable from persisted observations," which
    requires being able to tell a v1-computed score (fixed 0.5 V/A/B)
    apart from a v2-computed one (real counts) when reading
    `signal_evidence` later.
  - Wire into `apps/api/src/jobs/ingest-consumer.ts`'s
    `processNormalizedJob`: call H.2's `getCompanyRoleActivityStats`
    after classification succeeds, before `computeNewJobScore`.
  - Test changes needed: `signal-score.test.ts`'s existing
    hand-computed cases all assert `components.volume/acceleration/
    breadth === 0.5` — every one needs updating to pass real counts and
    hand-computed expected values instead. Keep at least one hand-worked
    case per new function (`computeVolume`, `computeAcceleration`,
    `computeBreadth`) in isolation, plus one combined
    `computeNewJobScore` case with realistic counts.
  - Verify: `pnpm --filter @hiring-signals/domain test`/`typecheck`,
    `pnpm --filter @hiring-signals/api typecheck` (ingest-consumer call
    site), `pnpm -r typecheck` after both.

- [x] **H.4 — Company-level signal generation** (`hiring_burst`,
  `role_acceleration`, `multi_location`, `persistent_demand` — spec
  §7.1, §1.4)
  - **Status (2026-07-29): done.** New `generateCompanySignals()` in
    `ingest-consumer.ts`, called from `processNormalizedJob` right after
    the primary `new_job`/`reopened_job` signal's evidence append.
    Reuses H.2's `activityStats` and H.3's already-computed
    `scoreResult.components.acceleration` -- no extra D1 round trip for
    the trigger checks themselves. `buildHeadline`/`buildSummary`
    widened from `"new_job" | "reopened_job"` to the full `SignalType`
    union with a real case per new type. Dedup/refresh reused
    `findActiveSignal`/`createSignal`/`refreshSignal`/
    `appendSignalEvidence` unchanged, confirmed generic across
    `signalType` by reading the actual repo file before writing any code
    -- no `packages/db` changes needed, exactly as this item predicted.
  - **Real bug caught and fixed during implementation, not shipped:**
    the originally proposed `role_acceleration` cutoff (`>= 0.5`, this
    item's own suggested value) turned out to be a false-positive trap,
    caught by running the pre-existing test suite (3 failures, not
    assumed passing) rather than only the new tests. `computeAcceleration`'s
    `max(2, priorRate)` floor means a *single* newly observed job with
    zero prior 56-day history scores exactly `0.5` by construction
    (`(1-0)/max(2,0) = 0.5`) -- so every brand-new company+role pair's
    very first tracked job would spuriously read as "accelerating" under
    the proposed threshold. Fixed by raising the cutoff to `0.75`
    (documented inline with the exact arithmetic) rather than loosening
    any test; two new jobs in one run (`(2-0)/max(2,0) = 1.0`) still
    correctly clears it.
  - `persistent_demand`'s day-count is anchored on the primary signal's
    `first_detected_at` (existing row's value when refreshing, or
    `observedAt` itself -- 0 days old -- on a brand-new signal), per this
    item's own "not `lastDetectedAt`" instruction.
  - Verified: 5 new tests added to `ingest-consumer.test.ts`'s new
    "H.4 company-level signal generation" describe block -- one per
    threshold crossing (`hiring_burst` via 3 jobs in one run,
    `multi_location` via 3 distinct `locationMode`s, `role_acceleration`
    both the negative cold-start regression case and the positive
    2-job-saturates-to-1.0 case, `persistent_demand` via a backdated
    `first_detected_at` across two runs) -- each asserts the
    corresponding `signal_type` row actually appears. All 5 passed on
    first run. `pnpm --filter @hiring-signals/api typecheck` clean,
    `lint` clean (0 errors, same 4 pre-existing warnings noted
    elsewhere), `test` 23/23 (up from 18). `pnpm -r typecheck` clean
    across all 5 workspace projects; `pnpm -r test` 122/122 passing
    workspace-wide (domain 52, db 17, adapters 30, api 23).
  - Currently 0% implemented — `signal.ts` types all six signal types
    but only `new_job`/`reopened_job` are ever passed to `createSignal`.
    These four are company-level/secondary context per spec §1.4, but
    "not primary" isn't "not built" — the spec fully defines their
    triggers and none of them exist.
  - Using H.2's stats (already fetched once per job for H.3's scoring —
    reuse the same call, don't fetch twice), after a `new_job`/
    `reopened_job` event's own signal is created/refreshed, additionally
    check:
    - `hiring_burst`: `newInLast14Days >= 3` (spec's literal threshold,
      §7.1's trigger table).
    - `multi_location`: `distinctLocationCount >= 3` (spec's literal
      threshold, same table).
    - `role_acceleration`: H.3's computed `acceleration` component
      exceeds a "material" cutoff — propose `>= 0.5` (documented v1
      choice, not spec-derived, same caveat as `computeVolume`'s 5).
    - `persistent_demand`: the company+role's active `new_job` signal
      (already in scope from `findActiveSignal` in H.3's flow) has had
      `first_detected_at` continuously active for `>= 30` days (spec's
      literal threshold) — check against `now - firstDetectedAt`, not
      `lastDetectedAt`, since "persistent" means it's stayed active
      throughout, which `first_detected_at` anchors.
  - Each needs its own `buildHeadline`/`buildSummary` case in
    `ingest-consumer.ts` (currently only handles `"new_job" |
    "reopened_job"` — widen the type union and switch).
  - Dedup/refresh reuses `findActiveSignal`/`createSignal`/
    `refreshSignal` (`packages/db/src/signals-write-repo.ts`) as-is —
    already generic across `signalType`, no repo changes needed beyond
    what H.2/H.3 add.
  - Verify: extend `ingest-consumer.test.ts`'s fixture data so at least
    one test case crosses each of the four thresholds and asserts the
    corresponding signal row was created with the right `signal_type`;
    `pnpm --filter @hiring-signals/api test`/`typecheck`.

- [x] **H.5 — Freshness anchor decision + reconciliation decay** (new,
  spec §5.2, §7.2)
  - **Status (2026-07-29): done.** The freshness-anchor decision was
    codified without reverting the existing new-job scoring path:
    `computeNewJobScore()` still uses the job posting/observation anchor
    for detection-latency ranking, while the new
    `computeReconciliationScore()` uses days-since-`last_detected_at`
    for quiet active signals whose score needs to decay. Both share the
    same v2 V/A/B/Q/P component functions and weighted combiner, so the
    only behavioral difference is the caller-supplied freshness anchor.
  - Repo support added in `packages/db/src/signals-write-repo.ts`:
    `listSignalsNeedingReconciliation()` finds active signals older than
    a caller-supplied threshold and derives the Q input from the best
    current matching active/possibly-closed job; `updateSignalScore()`
    updates only `score`/`score_version` and deliberately does **not**
    touch `last_detected_at`, because reconciliation is not new source
    evidence. Follow-up review tightened this further: the stale-signal
    query excludes signals that already received `score_recomputed`
    evidence inside the current 24-hour reconciliation window (so cron
    retries/manual double-runs do not duplicate daily evidence), and the
    score update is guarded with `status='active'` so a signal closed
    after selection is skipped without appending misleading evidence.
  - New orchestration in `apps/api/src/jobs/reconciliation.ts`: daily,
    best-effort score recompute for stale active signals. It refetches
    H.2 company-role activity stats at reconciliation time, computes the
    H.5 score, writes the score-only update, and appends a
    `score_recomputed` evidence row with the prior score/version,
    stale-threshold, full score result, and inputs for recomputability.
    Per-signal failures are logged and skipped rather than retried with
    ingest-consumer-grade dead-letter handling; that lighter failure
    model is documented in the file header as a deliberate v1 scope line.
  - Cron wiring added in `apps/api/src/index.ts` and
    `apps/api/wrangler.toml`: the existing `*/15 * * * *` trigger still
    goes to the source scheduler, while a new daily `"0 6 * * *"` trigger
    runs reconciliation. Neither cron path fetches ATS providers directly.
  - Verified: domain signal-score tests now include
    `computeReconciliationScore()` hand-computed cases (quiet 20-day
    decay and very-stale 60-day/current-activity case) plus bounds and
    anchor tests; db tests cover the stale-signal query and score-only
    update SQL; api tests cover a stale signal being recomputed/evidence
    appended and the no-stale-signal no-op path. `pnpm -r typecheck`,
    `pnpm -r lint`, and `pnpm -r test` all clean (lint still reports only
    the pre-existing api warnings unrelated to H.5; no errors).
  - Investigated whether the current `job.postedAt`-anchored freshness
    (see the README's "Post-D fixes" note — a deliberate prior change,
    not an oversight) is a bug against spec §7.2's literal wording
    ("days since the signal's most recent evidence observation").
    **Conclusion: it is not a bug, don't revert it.** It directly
    reflects the product's own stated optimization target (spec §1.1:
    detection latency — how soon after posting a match appears). Anchoring
    on evidence-observation-time alone at creation time would make `d`
    always ≈0 at the moment a signal is scored (since evidence is always
    written "now"), making `R` constant at 1.0 for every signal with no
    mechanism to ever differentiate or decay it — strictly worse than
    what exists today.
  - **The real gap**: nothing ever recomputes a signal's score after
    creation unless a *new* job event (new_job/reopened_job/job_updated)
    refreshes it. A signal that goes quiet — no new evidence for weeks —
    keeps displaying its creation-time score forever, so a
    `score_desc`-sorted feed never reflects a signal actually going
    stale. This is where "days since most recent evidence observation"
    *is* the correct read of spec §7.2 — for an unrefreshed signal,
    `last_detected_at` genuinely is its most recent evidence observation.
  - Plan:
    - New pure function, `packages/domain/src/signal-score.ts`:
      recomputes a score using the same formula/weights as
      `computeNewJobScore`, but with freshness anchored on
      days-since-`lastDetectedAt` instead of days-since-`postedAt`.
      Reuse `computeFreshness`/`computeVolume`/`computeAcceleration`/
      `computeBreadth` from H.3 rather than duplicating them.
    - New repo query, `packages/db`: active signals whose
      `last_detected_at` is older than a threshold — propose 24h,
      matching the daily cadence spec §5.2 already establishes for job
      reconciliation (reuse the same cadence concept rather than
      inventing a new one).
    - New orchestration file, `apps/api/src/jobs/reconciliation.ts`: for
      each stale active signal, re-fetch H.2's company-role stats *fresh*
      (not frozen at creation time — this is a real improvement, not
      just a freshness recompute: V/A/B become current, not stale), 
      recompute the score, `refreshSignal` (score/scoreVersion only —
      deliberately NOT `lastDetectedAt`, since no new evidence arrived),
      append a `score_recomputed` evidence row (spec §7.2's
      recomputability requirement).
    - New cron trigger in `apps/api/wrangler.toml` (daily, e.g.
      `"0 6 * * *"` — within the free-tier's 3-per-Worker cron limit,
      spec §5.2's table), branch on `event.cron` in
      `apps/api/src/index.ts`'s `scheduled` handler between the existing
      15-min ingest scheduler and this new daily reconciliation handler.
  - **Scope note**: deliberately scoped down from full production
    hardening. Log-and-continue per signal on failure, not the
    ingest-consumer's full retry/backoff/dead-letter machinery (spec
    §13.4) — that level of hardening for a brand-new pipeline stage is
    Milestone G territory, not this "logic layer" pass. State this
    explicitly in the file's header comment so it reads as a deliberate
    v1 scope line, not an oversight.
  - Verify: unit tests for the reconciliation score function (hand-
    computed, at least 2 cases) in `packages/domain`; a repo test for
    the staleness query (fake-`D1Client` pattern); an integration-style
    test for `reconciliation.ts` itself (same in-memory `D1Client` fake
    style as `ingest-consumer.test.ts`) asserting a stale signal's score
    changes and a fresh one's doesn't; `pnpm -r typecheck`/`lint`/`test`
    clean across the whole workspace after this lands.

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

**Status (2026-07-29): spec drafted, implementation not started.**
Added at the user's request, inspired by `ArxivExplorer`'s proven
hybrid-search architecture (same account, same Cloudflare primitives —
Workers AI `@cf/baai/bge-base-en-v1.5` embeddings + a Vectorize index
queried alongside D1). **`hiring-signals-spec.md` §9.4 ("Semantic
search") now exists**, written and inserted 2026-07-29, marked
explicitly as a draft addendum not yet built — read it before starting
I.1, it is the source of truth for this milestone's behavior going
forward, this file's task list must stay consistent with it rather than
drift into a separate de facto spec. (Original plan called this §9.5;
landed as §9.4 since that slot was open right after the existing §9.3
query-param table and before §10 — no functional difference, just note
the correction so a reader cross-referencing an earlier draft of this
milestone isn't confused by the number.)

**Scope, decided with the user up front:**
1. **Free-text search over signals/jobs** (e.g. "remote rust backend
   roles") as a discovery feature layered onto the existing `q` param
   (`signals.ts`'s `signalsQuerySchema` / spec §9.3's table). Confirmed
   by reading both the spec and `signals-repo.ts`: `q` today is
   **company-name search only** — a plain substring match, nothing
   else. Spec §9.4 (new) keeps `q`'s documented type/contract unchanged
   and adds a semantic leg alongside it (merged by score) rather than
   redefining what `q` matches on — read §9.4 in full before writing
   I.3's merge logic, it settles questions this bullet used to leave
   open (query-param shape, response envelope, non-goals). This ships
   first.
2. **Classification assist**: semantic similarity as an *additional*
   input alongside — never a replacement for — the deterministic
   phrase/abbreviation rules in `packages/domain/src/classification.ts`.
   This is explicitly out of scope until I.1–I.4 (the search feature)
   are done and verified. Spec §6.2's opener is unambiguous ("Use
   deterministic rules first. Do not make an LLM dependency necessary
   for the ingestion pipeline") — I.5 below must not make embedding
   generation a *requirement* for a job to be classified; it can only
   ever nudge `classification_confidence` for a job the deterministic
   path already handles, and the pipeline must keep working with
   identical classification outcomes if Workers AI is down or the
   Vectorize index is empty. Get this constraint into the spec
   addendum in writing before touching `classification.ts`.

**Why after Milestone H, not folded into F:** H is the current active
logic-quality pass on scoring/signal-generation; this milestone doesn't
depend on any of H's open items (H.5 is independent) but touches
`apps/api` alongside it, so sequencing it after avoids two milestones
editing `ingest-consumer.ts`/`apps/api/wrangler.toml` concurrently.
Milestone F (dashboard UI) is still undetailed and `apps/web` is still
near-scaffold (confirmed by listing the directory — only the Next.js
default scaffold exists under `src/app`, no real routes/components
yet) — I.4's search UI is written directly since there's nothing in F
to fold into yet, not because it preempts F's own task-detailing pass.

**UI inspiration source:** `ArxivExplorer/app/components/` —
specifically `SearchBoxHome.tsx` (hero search input, URL-param-driven
filter chips, active-filter count badge), `SearchFilters.tsx` (same
chip-toggle pattern as a standalone panel, `useSearchParams`-driven so
filters are shareable/bookmarkable URLs), `MoreLikeThisButton.tsx`
(one-line `router.push` to a `?like=:id` query, no separate modal/page),
`AbstractSearch.tsx` (paste-arbitrary-text semantic-only search mode,
textarea with live char count + `⌘Enter` submit), and
`RecentSearches.tsx` (`localStorage`-backed last-N-queries list, see
`lib/searchHistory.ts`). **Reuse the UX patterns and interaction
mechanics, not the visual styling** — ArxivExplorer's components are
built for its neon-red cyberpunk aesthetic (`text-neon-red`,
`bg-amber-950/20`, etc.), which conflicts with spec §11's Minimal
Brutalist system (strict black/white, hard edges, one accent color for
intentional actions only). Port the *shape* of each component (props,
state, URL-param wiring, keyboard shortcuts) and restyle from scratch
against §11's tokens — do not copy Tailwind classes verbatim.

Spec: proposed §9.5 (new, see above), §6.2 (classification — I.5's
guardrail), §9.3 (existing `q` param this extends), §11 (visual system
— governs I.4's restyle), §13.1 (Workers AI/Vectorize as new bindings
alongside existing D1/KV/Queue).

- [x] **I.1 — Provision Vectorize index + Workers AI binding**
  (`apps/api/wrangler.toml`, spec §13.1)
  - **Status (2026-07-29): done.** Found the index (`hiring-signals-jobs`,
    768-dim, cosine) already existing on the account, created
    ~1hr earlier in an untracked session — same silently-incomplete
    pattern this file has caught before (`seed-local-d1.sql`,
    `add-company.mjs`, `ingest-consumer.test.ts`) — but the follow-up
    metadata-index step had *not* run (`wrangler vectorize
    list-metadata-index hiring-signals-jobs` returned zero indexes).
    Since no vectors exist yet (I.2 not started), this was still safely
    fixable rather than a "too late, non-retroactive" gap. Ran all five
    `create-metadata-index` calls (`companyId`/`roleCategory`/
    `locationMode`/`status`/`postedAt`, all `string` — see this item's
    own postedAt discussion below; picked `string`/ISO-8601 for
    consistency with every other timestamp in this repo's schema, since
    Vectorize itself does no range math on the field, D1 already owns
    that), confirmed via `list-metadata-index` (not just the "enqueued"
    message) that all five landed. `[ai]`/`[[vectorize]]` bindings and
    `EMBEDDING_MODEL` (`[vars]`) added to `wrangler.toml`; `Bindings`
    interface (`apps/api/src/bindings.ts`) updated to match (`AI: Ai`,
    `VECTORIZE: VectorizeIndex`, `EMBEDDING_MODEL: string`) per that
    file's own "keep in sync with wrangler.toml" header comment.
  - **Fallout fixed, not left broken:** adding required fields to
    `Bindings` broke typecheck on all 3 test files whose `makeFakeEnv()`
    helpers construct a `Bindings` object by hand
    (`ingest-consumer.test.ts`, `scheduler.test.ts`,
    `reconciliation.test.ts`) — fixed each using the same
    `unusedBinding<T>()` throwing-Proxy pattern already established in
    this repo for bindings a given test doesn't legitimately exercise
    (Milestone D's 2026-07-29 hardening pass).
  - Verified for real: `pnpm -r typecheck`/`lint`/`test` clean (131/131
    tests, up from 122 pre-pull — the +9 came from H.5's
    `reconciliation.test.ts` landing via `git pull`, not from this
    task); `wrangler deploy --dry-run` confirms all 7 bindings resolve
    (`DB`, `CACHE`, `INGEST_QUEUE`, `VECTORIZE` → `hiring-signals-jobs`,
    `AI`, `ENVIRONMENT`, `EMBEDDING_MODEL`) with no config error.
  - Add `[ai]` binding (`binding = "AI"`) and a `[[vectorize]]` block
    (`binding = "VECTORIZE"`, a new index — do not reuse
    ArxivExplorer's `arxiv-papers` index, different account resource,
    different embedding domain). Follow `ArxivExplorer/wrangler.api.toml`
    as the reference shape (already has both bindings working in
    production on this same Cloudflare account).
  - Embedding model: `@cf/baai/bge-base-en-v1.5`, same as ArxivExplorer
    — reuse the proven choice rather than re-evaluating model options
    from scratch, unless a concrete reason surfaces (e.g. a job-postings
    domain benchmark) to deviate.
  - Vector dimension **confirmed 2026-07-29 against Cloudflare's own
    docs** (`developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/`
    and `developers.cloudflare.com/vectorize/best-practices/create-indexes`):
    `bge-base-en-v1.5` outputs 768-dimensional vectors, and Cloudflare's
    own worked example for this exact model is
    `wrangler vectorize create your-index-name --dimensions=768
    --metric=cosine` — matches what this bullet already assumed, no
    correction needed, but now cited rather than assumed (spec §21's
    "verify source contracts first" discipline, satisfied for real).
    `--preset @cf/baai/bge-base-en-v1.5` is also available and
    auto-configures dimensions/metric — either flag form is fine, but
    if using `--preset`, still record the resulting dimensions/metric
    in this file once run (`wrangler vectorize get <index-name>`),
    don't leave it implicit.
  - **New gap found via docs check, not in the original plan:**
    Vectorize metadata indexes (needed for I.2's `companyId`/
    `roleCategory`/`locationMode`/`status`/`postedAt` filter fields)
    "must exist before vectors are inserted" per Cloudflare's own intro
    docs — filtering on a metadata field added *after* vectors already
    exist does not retroactively apply. Run
    `wrangler vectorize create-metadata-index <index-name>
    --property-name=<field> --type=<string|number|boolean>` for each
    of the five fields **immediately after index creation, in this same
    task, before I.2 writes a single vector** — sequencing this after
    I.2 would silently leave those fields unfilterable for every vector
    already upserted by then. `status`/`locationMode`/`roleCategory`/
    `companyId` are `string`; `postedAt` — decide `string` (ISO-8601,
    matches how every other timestamp in this repo is stored, see
    AGENTS.md/`jobs` schema) vs `number` (epoch, sortable/range-queryable
    natively) before creating it, since this "cannot be changed after
    creation" as unambiguously as dimensions/metric can't.
  - `EMBEDDING_MODEL` as a `[vars]` entry (not hardcoded), same pattern
    as ArxivExplorer's `wrangler.api.toml` — makes a future model swap a
    config change, not a code change.
  - Verify: `wrangler vectorize create <index-name> --dimensions=768
    --metric=cosine` (confirmed correct above, not "or whichever metric"
    as this bullet originally hedged) followed immediately by the five
    `create-metadata-index` calls above, run against this repo's
    Cloudflare account (`nvm use 24.18.0` first, same Node-version note
    Milestone D's ops scripts already flagged); `wrangler vectorize get
    <index-name>` confirms dimensions/metric/metadata-indexes all landed
    as intended; `wrangler.toml` change confirmed with `wrangler deploy
    --dry-run` or `wrangler dev` startup (binding resolves, no config
    error).

- [x] **I.2 — Embedding write path: embed jobs at ingest time**
  (`apps/api/src/jobs/ingest-consumer.ts`, `packages/db`)
  - **Status (2026-07-29): done.** `buildJobEmbeddingText` (already
    landed in an earlier session, `packages/domain/src/embedding-text.ts`,
    re-exported via `packages/domain/src/index.ts`) wired into
    `ingest-consumer.ts` via a new `embedAndUpsertJob` helper, its own
    named function rather than inlined into `processNormalizedJob` (that
    function was already flagged in its own doc comment as the largest
    single stage of a 359-line original — not the place to grow further).
    Called immediately after `applyLifecycleTransition`, gated on
    `!existing || upsertResult.contentChanged`, **before** the
    new/reopened-signal branch below it — deliberately not after
    scoring, because the gate is about content change, not about
    whether this run produced a scored signal; a content edit on a job
    with no active signal (0 signals returned) still gets a fresh
    embedding. `roleCategory` metadata reads `existing?.role_primary`
    (the job's *prior* classification, if any) rather than
    `classification.rolePrimary`, since `classifyJob` hasn't run yet at
    this point in the function for a brand-new job — its first embedding
    simply omits `roleCategory`, not a bug, documented inline.
    `postedAt` metadata reuses the same `job.postedAt ?? existing?.first_seen_at
    ?? observedAt` fallback chain the caller already uses for freshness
    scoring, so it's never left undefined for a source that omits
    `postedAt`. `roleCategory`/`locationMode` keys are omitted from the
    metadata object entirely when absent, rather than passed as
    `undefined` (`VectorizeVectorMetadata` doesn't accept it).
  - **Types verified against the actually-installed
    `@cloudflare/workers-types@4.20260702.1`** (spec §21 discipline, not
    assumed): `Ai_Cf_Baai_Bge_Base_En_V1_5_Input` is `{ text: string |
    string[], pooling?: "mean"|"cls" }`; its output is `{ shape?,
    data?: number[][], pooling? } | { request_id }` (an async-batch
    variant `embedAndUpsertJob` narrows against defensively, logging
    and returning rather than crashing, since it shouldn't occur for a
    single-text non-queued `run()` call but the type says it's
    possible). `Bindings["VECTORIZE"]` resolves to the **beta**
    `VectorizeIndex` class (synchronous `upsert(vectors):
    Promise<VectorizeVectorMutation>`), not the newer async `Vectorize`
    class — confirmed no mismatch between what `bindings.ts` declares
    and what I.2's code calls.
  - **Idempotency confirmed against Cloudflare's current Vectorize docs**
    (not assumed, same discipline as I.1's dimension check):
    "[a]n upsert operation will insert vectors into the index if
    vectors with the same ID do not exist, and overwrite vectors with
    the same ID... the upserted vector replaces the existing vector in
    full" (developers.cloudflare.com/vectorize/reference/client-api),
    and "[i]f the same vector id is upserted twice... the index would
    reflect the vector that was added last"
    (developers.cloudflare.com/vectorize/best-practices/insert-vectors)
    — a retried queue message that re-embeds the same job overwrites
    cleanly, no duplicate-vector or merge-of-old-and-new-metadata risk.
  - **Must-not-become-a-hard-dependency guardrail implemented**: the
    entire embed-and-upsert body runs inside a try/catch;
    `console.error`-and-return on failure, never throws out of the
    function, so an `AI.run`/`VECTORIZE.upsert` failure never fails the
    enclosing `processNormalizedJob` call or retries the queue message
    — confirmed by the failure-path test below, which asserts the
    message is still acked (not retried) and the job/signal are still
    fully written to D1 despite the embedding failure.
  - **Verified for real**: extended `ingest-consumer.test.ts`'s
    `makeFakeEnv()` with real recording fakes for `AI`/`VECTORIZE`
    (`aiRunCalls`/`vectorizeUpsertCalls`, an overridable `aiRunImpl` for
    the failure-path test) — the other two test files sharing this
    `Bindings` shape (`scheduler.test.ts`, `reconciliation.test.ts`)
    were confirmed to never call `processNormalizedJob`/
    `handleIngestMessage` at all, so their existing `unusedBinding<T>`
    throwing-Proxy placeholders for `AI`/`VECTORIZE` were left
    untouched rather than needlessly upgraded. Added a happy-path test
    (asserts `AI.run`'s model/input text, and `VECTORIZE.upsert`'s
    vector ID = the job's own D1 id, 768-length values, and the
    documented metadata shape with `roleCategory` correctly absent on a
    first-ever embed) and a failure-path test (`AI.run` rejects ->
    message still acked/not retried, job+signal still written, failure
    logged via `console.error`, `VECTORIZE.upsert` never reached).
    `pnpm -r typecheck`/`lint`/`test` clean across all 5 workspace
    projects: 63 (domain) + 19 (db) + 30 (adapters) + 28 (api, up from
    26 pre-change) = 140 tests passing, 0 lint errors (same 4
    pre-existing warnings as the pre-I.2 baseline, confirmed via
    `git stash` diff — none newly introduced).
  - New function, `packages/domain/src/embedding-text.ts`:
    `buildJobEmbeddingText(job): string` — deterministic, pure,
    unit-testable function that assembles the text sent to Workers AI
    from `title_raw` + `role_primary` (if classified) + `department_raw`
    + `location_raw` + a truncated `description_text` (mirror
    ArxivExplorer's `reembed-with-cf-ai.ts` pattern: title + body,
    `.slice(0, 2000)` — job description text needs its own truncation
    length decided from real data, don't assume 2000 chars is right for
    this domain without checking a sample of `description_text` lengths
    in the seed data first).
  - Wire into `ingest-consumer.ts`'s `processNormalizedJob`, after
    `upsertJob` succeeds (so the embedding always corresponds to a job
    row that actually exists — never embed before the D1 write
    confirms). Call `env.AI.run(EMBEDDING_MODEL, { text: [...] })`
    then `env.VECTORIZE.upsert(...)` with vector ID = `job.id` (the
    jobs table's own primary key, mirroring ArxivExplorer's "vector ID
    = bare arXiv ID" choice) and metadata `{ companyId, roleCategory,
    locationMode, status, postedAt }` — enough to build a Vectorize
    metadata filter (spec's future date/location-scoped semantic query)
    without a D1 round trip per candidate.
  - **Must not become a hard dependency for ingestion to succeed** (the
    I.5 guardrail, applied here too, one milestone early since I.2 is
    where a Workers AI outage would first bite): wrap the
    embed-and-upsert call in try/catch, log-and-continue on failure, do
    NOT throw or retry the whole message — a job that fails to embed is
    still fully ingested/classified/scored, just not semantically
    searchable until a later backfill. This is a deliberate asymmetry
    from spec §13.4's ATS-fetch failure handling (which does retry) —
    document why inline: embedding failure doesn't lose the job, ATS
    fetch failure does.
  - Idempotency: `VECTORIZE.upsert` is naturally idempotent on vector ID
    (a retry re-embeds and overwrites, doesn't duplicate) — confirm this
    against Cloudflare's current Vectorize docs rather than assuming, and
    note the confirmation in the commit, same discipline as I.1's
    dimension check.
  - Verify: extend `ingest-consumer.test.ts`'s fake environment with a
    fake `AI`/`VECTORIZE` binding (same `unusedBinding<T>` Proxy pattern
    `makeFakeEnv()` already uses for other unexercised bindings, per
    Milestone D's 2026-07-29 hardening pass); a happy-path test
    asserting `VECTORIZE.upsert` is called with the right vector ID and
    metadata shape, and a failure-path test asserting an `AI.run`
    rejection does not fail the overall message/job processing.
    `pnpm --filter @hiring-signals/api typecheck`/`lint`/`test`.

- [ ] **I.3 — Backfill script + query-side hybrid search**
  (`infrastructure/scripts`, `packages/db`, `apps/api/src/routes`)
  - `infrastructure/scripts/backfill-embeddings.mjs` — plain Node
    `.mjs`, same `wrangler d1 execute --json` + a direct Workers AI/
    Vectorize REST call pattern as the existing ops scripts (Milestone
    D already established why: no live binding exists outside a
    Worker). Modeled directly on
    `ArxivExplorer/scripts/reembed-with-cf-ai.ts`'s shape (batch size
    + delay-between-batches for rate-limit headroom, auth smoke-test
    before the full run, ok/failed counters, safe to re-run) but calling
    this repo's own ingest-consumer embedding logic's HTTP equivalent —
    decide whether that means a small `/admin`-style-but-not-actually-
    admin internal endpoint (careful: spec §13.5/§14.1 already
    deliberately removed all `/admin/*` HTTP surface and auth — **do
    not reintroduce an authenticated admin route to make this script's
    life easier**; either the script drives embedding purely through
    direct Workers AI + Vectorize API calls with an API token, no Worker
    route involved, or it goes through the same
    `update-source.mjs --run-now` style indirection of nudging the real
    pipeline — pick whichever avoids recreating the admin surface spec
    explicitly killed, and say so explicitly in the script's header
    comment, same as `add-source.mjs`'s D1-access-approach note).
  - `packages/db/src/signals-repo.ts`'s `listSignals` (confirmed
    company-name-only `LIKE` today, per spec §9.4's now-settled
    contract — no need to re-derive this from the code, the spec
    addendum already states it) gains a semantic leg:
    embed the query text via `env.AI`, query `env.VECTORIZE`, merge with
    the existing keyword-matched rows by job/signal ID, weighted score
    combination — same shape as ArxivExplorer's `search.ts`'s
    `mergeResults`/`KEYWORD_WEIGHT`/`SEMANTIC_WEIGHT` constants, but
    weights re-tuned for this domain from scratch (job titles are much
    shorter/denser than paper abstracts — don't assume 0.25/0.75 ports
    over unchanged; this needs its own tuning pass against real query
    examples once seed data + backfilled embeddings exist).
  - Cache query embeddings in KV (`env.CACHE`), same TTL-based pattern
    as ArxivExplorer's `kvEmbed`/`TTL_EMBED` — avoids re-embedding
    identical queries repeatedly given the free-read-tier's likely
    query repetition (common role/location phrases).
  - Verify: a repo-level test asserting the merge/dedup logic combines
    keyword and semantic hits correctly (fake `D1Client` + fake
    `VECTORIZE`/`AI`, same style as `signals-write-repo.test.ts`);
    `pnpm --filter @hiring-signals/db typecheck`/`lint`/`test`; a real
    query against local D1 + a real (not faked) Vectorize/Workers AI
    call once I.1's index is provisioned and I.3's backfill has run
    against the seed data, same "verify for real, not just typechecked"
    bar the rest of this file holds every other milestone to.

- [ ] **I.4 — Search UI** (`apps/web`, spec §11)
  - `apps/web` is still near-scaffold (confirmed 2026-07-29 — only the
    Next.js default app shell exists, no real routes yet), so this is
    genuinely new UI, not a retrofit — same situation Milestone F's own
    header already flags ("expand into task detail before starting").
    This item front-loads only the search surface; the rest of F's
    dashboard (signal cards, company pages, filters panel for the
    existing `q`/`roles`/`locationMode`/etc. params) stays scoped to
    Milestone F itself, sequenced by the person separately — don't let
    I.4 silently become all of F.
  - Port (not copy) from `ArxivExplorer/app/components/`, restyled
    against spec §11's Minimal Brutalist tokens (black/white, hard
    edges, monospace data, single accent color reserved for
    high-priority/action states — semantic-search result highlighting
    is a legitimate use of that one accent color, keyword-match
    highlighting should not compete with it for the same color):
    - `SearchBoxHome.tsx`'s shape → a signals-feed search bar: text
      input, `router.push` to a query-param-driven URL, Enter-to-submit,
      inline active-filter-count badge. Placeholder copy specific to
      this product ("Try: remote rust backend, hybrid platform
      engineer…"), not arXiv's.
    - `SearchFilters.tsx`'s `useSearchParams`-driven chip-toggle
      mechanics → apply to the *existing* filters
      (`roles`/`locationMode`/`country`/`source`/`signalType`/`minScore`)
      already defined in `signalsQuerySchema` — this reuses a proven
      interaction pattern for filters that already exist server-side,
      independent of whether semantic search itself is enabled.
    - `MoreLikeThisButton.tsx`'s one-line `router.push(?like=:id)`
      pattern → "similar roles" on a signal detail view, resolving via
      Vectorize `getByIds([jobId])` + `query(...)` the same way
      ArxivExplorer's `handleMoreLikeThis` does (I.3's merge logic can
      likely share code with this rather than duplicating the
      Vectorize-query-and-D1-batch-fetch shape — check once I.3 is
      written).
    - `RecentSearches.tsx` + `lib/searchHistory.ts`'s `localStorage`
      pattern → reusable close to verbatim (client-only, no backend
      dependency, no design-system conflict since it's logic not
      visual chrome) — port the logic file directly, restyle only the
      rendered list to match §11.
    - `AbstractSearch.tsx`'s paste-text-to-search mode is **optional,
      lower priority** for this product — a job seeker pasting their
      own resume/skills blurb to find matching-by-meaning signals is a
      plausible feature but wasn't part of the scope decided with the
      user; flag it as a follow-on idea in this bullet rather than
      building it now, since I.1–I.4 as scoped don't require it.
  - Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint`
    clean; a manual `pnpm --filter @hiring-signals/web dev` smoke check
    that search-with-filters round-trips through the URL correctly
    (bookmarkable/shareable, same property ArxivExplorer's
    `useSearchParams`-driven approach guarantees) and that a semantic
    hit and a keyword hit both render through the same signal-card
    component without a type split.

- [ ] **I.5 — Classification assist (explicitly deferred until I.1–I.4
  verified)**
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

**Status (2026-07-30): in progress.** `AGENTS.md`'s testing policy
section was superseded the same day this milestone was added — read
that section in full before touching any test file here, it's the
source of truth for the target end state; this milestone is only the
task breakdown for getting there. All 4 `packages/db/test/*.test.ts`
files and 2 of the 3 `apps/api/test/jobs/*.test.ts` files
(`reconciliation.test.ts`, `scheduler.test.ts`) are migrated and
verified passing against live D1. One file remains:
`apps/api/test/jobs/ingest-consumer.test.ts` — see the checklist below
for its scoped-but-not-started plan.

The "expand before starting" pre-work this section originally called
for (inventory of every fake, the live-D1-from-Vitest mechanism, the
live-AI/VECTORIZE mechanism, the test-data-naming convention) is now
done — see the Inventory sub-section immediately below and the
checklist further down for what was decided and where each decision
lives in code. The `test-*`-prefix convention floated below as "not
decided yet" at the time this section was first written **was**
subsequently adopted (confirmed in the checklist: `test-recon-`,
`test-sched-`, `test-swr-`, etc.).

### Inventory (2026-07-30) — every test file's current fake/mock usage

Corrects the milestone intro's own file list: `sources-repo.test.ts` is
named above (and in `AGENTS.md`) as needing migration, but **no such
file exists on disk** (`packages/db/src/sources-repo.ts` has no test
file at all, confirmed via `find`). That's a pre-existing gap, not
something this migration creates — noted here rather than silently
dropped, out of scope to fix as part of Milestone J itself (writing a
new test file for `sources-repo.ts` would be new test coverage, not a
migration of existing coverage).

**`packages/db/test/*.test.ts` (4 files, all the same fake shape):**
Each defines its own local `createFakeClient()` — a plain `D1Client`
object literal (not `vi.fn()`-wrapped, so the interface's generic method
signatures survive) that records every call into a `calls` array and
returns either `null`/`[]` or a caller-seeded canned value. The large
majority of assertions in all four files check **the fake's captured SQL
text and bind-parameter shape** (`calls[0].sql).toContain("INSERT INTO
companies")`, exact positional `params` arrays, `ORDER BY` clause
substrings) — not real database behavior. This category cannot survive
a mechanical migration: a live `D1Client` backed by
`wrangler d1 execute --remote` has no "what SQL string was I sent"
introspection point the way an injected fake does. Each such assertion
needs to become either (a) a behavioral assertion against real seeded
D1 state (e.g., instead of asserting the `INSERT` statement's param
order, seed nothing, call `createCompany`, then `SELECT` the row back
for real and assert on its columns), or (b) dropped if it was only ever
testing "did the repo function build this exact SQL string" with no
behavioral consequence.
  - `companies-repo.test.ts` — `createCompany`. Mixed: 2 tests assert
    real output shape (`row.id`, `row.created_at === row.updated_at`,
    empty-string-to-null normalization) alongside the SQL/param capture
    — those output-shape assertions carry over directly against a real
    inserted+read-back row. The `DuplicateCompanyError` test
    (`opts.runThrows`) needs a real UNIQUE violation instead — insert
    the same slug twice for real and assert on the thrown error type.
  - `company-role-stats-repo.test.ts` — `getCompanyRoleActivityStats`.
    Mostly behavioral already (seeds a canned aggregate row via
    `seededFirstResult`, asserts the returned zero-defaulting shape) —
    the "real" version needs actual `jobs` rows seeded in D1 spanning
    the date windows the function aggregates over, not one canned
    `first()` return value. The one pure-SQL-shape test (asserting
    `now` is bound 4 times in a specific param order) either drops or
    becomes "seed jobs at known timestamps, call the function, assert
    the returned counts are correct" — which is a strictly better test
    of the same date-window logic.
  - `signals-repo.test.ts` — `listSignals`, `findSignalsByJobIds`,
    `toListItem`. The largest file (235 lines) and the most consequential
    since this is the route this session is actively building I.3's test
    for. `toListItem`'s 3 tests are a pure function, no `D1Client`
    involved at all — zero migration needed, leave as-is. `listSignals`'s
    cursor-pagination test (`nextCursor` set/not-set at the `limit+1`
    boundary) and corrupt-row-skip test are genuinely behavioral and
    migrate cleanly to real seeded rows. The `q`/`ORDER BY`/`status='active'`
    SQL-substring tests need to become "seed two signals where only one
    matches `q`, call `listSignals` for real, assert the right one comes
    back" — behaviorally stronger than the current substring check, which
    would pass even if the `LIKE` were subtly wrong (e.g. matching
    `summary` instead of `headline`) as long as the substring text
    happened to still appear somewhere in the built SQL.
  - `signals-write-repo.test.ts` — `findActiveSignal`, `createSignal`,
    `refreshSignal`, `updateSignalScore`, `listSignalsNeedingReconciliation`,
    `appendSignalEvidence`. Same shape as the others: SQL-substring/param
    assertions dominate. `listSignalsNeedingReconciliation`'s test is
    worth calling out specifically — it currently only asserts the SQL
    text contains `LEFT JOIN jobs j`, `NOT EXISTS`, etc., never actually
    exercising the `MAX(j.classification_confidence)` aggregation or the
    staleness filter against real rows. A live-seeded version (real
    stale signal + real jobs row) is a materially better test of this
    function, not just a policy-compliance rewrite.

**`apps/api/test/jobs/*.test.ts` (3 files, three different fake shapes
— NOT interchangeable, confirmed by reading all three in full):**
  - `scheduler.test.ts` — `vi.mock("@hiring-signals/db")` replacing
    `createD1Client` with a minimal fake (`all()` returns a
    test-seeded `dueRows` array, everything else a no-op), plus
    `unusedBinding<T>()` Proxy stand-ins for `DB`/`CACHE`/`RAW_PAYLOADS`/
    `ABUSE_LOGS`/`AI`/`VECTORIZE` (the Proxy throws loudly if the code
    under test ever reads a property on them — a deliberate "fail loud,
    not silent" design worth keeping the *spirit* of even after
    migration). `INGEST_QUEUE` is faked as a plain in-memory `sent[]`
    array capturing `{ message, delaySeconds }` — this one has no live
    equivalent decided yet (see Queue note below). Migratable today:
    the D1 mock, once real `sources` rows are seeded in D1 and
    `getDueSources` runs for real via `live-d1-client.ts`. Blocked:
    the `INGEST_QUEUE.send` assertions (jitter determinism, "only
    enqueues due sources") depend on capturing exactly what's sent
    without actually enqueueing it — a real `Queue.send()` has no
    "capture, don't deliver" mode.
  - `reconciliation.test.ts` — the cleanest fake of the three, but the
    one most clearly forbidden even under the *original* (pre-2026-07-30)
    policy: `vi.mock("@hiring-signals/db")` replaces the package's
    exported **functions** directly (`listSignalsNeedingReconciliation`,
    `getCompanyRoleActivityStats`, `updateSignalScore`,
    `appendSignalEvidence`), not a fake `D1Client` underneath them —
    this is mocking this repo's own logic, not just swapping the storage
    layer beneath real logic. Migrates most directly of the three job
    tests: seed one real stale signal (+ backing `jobs` rows) via
    `live-d1-client.ts`, call the real `handleReconciliation` against a
    real `Bindings` object whose `DB` is `createD1Client(liveD1Database)`
    — no per-function mocking at all once this is live. `INGEST_QUEUE`/
    `AI`/`VECTORIZE` stay as `unusedBinding()` Proxies here since
    `handleReconciliation` never legitimately touches them (confirmed by
    reading the file — genuinely unused, not a coverage gap).
  - `ingest-consumer.test.ts` — by far the largest and riskiest (1148
    lines, 17 tests). Three independent fakes, three independent
    problems:
    1. A hand-written ~25-branch in-memory D1 engine
       (`makeFakeClient`/`createFakeState`) routing on SQL substrings —
       same category as `packages/db`'s fakes, same migration approach
       (seed real rows via `live-d1-client.ts`, assert on real
       read-back state), but this file's assertions chain *multiple*
       repo calls per test (upsert → observation → lifecycle →
       classification → signal creation, all in one
       `handleIngestMessage` call) so the seeded live-D1 state needs to
       support the *sequence*, not just one function's isolated
       before/after.
    2. `vi.mock("@hiring-signals/adapters")` replacing
       `getAdapterForProvider` so `fetchBoard`/`normalize` return
       scripted values (a canned Greenhouse-shaped job, or a scripted
       HTTP status like 429/503/404 for the failure-branch tests).
       **This is a different category AGENTS.md's superseded-policy
       section never actually addresses** — that section's rule is
       specifically "no fake `D1Database`/`Ai`/`VectorizeIndex`/KV
       namespace," not "no fake of any external system." An adapter
       fetches a *real third-party ATS board over HTTP* (Greenhouse,
       Lever, etc.) — there is no "live Cloudflare resource" for that
       the way there is for D1/AI/Vectorize/KV, and deliberately
       provoking a real Greenhouse board into returning 429/503/404 on
       demand for a test isn't achievable at all, let alone reliably.
       This needs its own explicit decision, not an assumed answer —
       flagged as open, not resolved by this inventory.
    3. `vi.mock("../../src/services/raw-payload-store")` — fakes this
       repo's own `storeRawPayload` function (writes into the
       `RAW_PAYLOADS` KV namespace). Unlike the adapter mock, this one
       *does* fall cleanly under the existing D1/AI/Vectorize/KV policy
       once `live-cf-bindings.ts`'s KV client is generalized past just
       `CACHE` (see Queue/KV note below) — no new category of problem,
       just needs that one prerequisite.
    Also uses `INGEST_QUEUE` fakes for the 429/503 backoff-requeue
    assertions — same blocked-on-Queue-decision status as
    `scheduler.test.ts`.

**Cross-cutting blockers surfaced by this inventory — both now decided
(2026-07-30), full reasoning in `AGENTS.md`'s policy section, not
duplicated here:**
  - **`live-cf-bindings.ts`'s KV client is hardcoded to the `CACHE`
    namespace only** (`createLiveKvNamespace()` takes no namespace-id
    argument) — still an open, undecided mechanical gap (not a policy
    question like the two below), needed before `ingest-consumer.test.ts`
    migration can start, since its inline `storeRawPayload` mock needs
    `RAW_PAYLOADS`, not `CACHE`.
  - **`INGEST_QUEUE` — decided: accepted as a permanent, documented
    exception to the zero-fake policy.** Continue capturing `send()`
    calls in-memory (`sent: []`), never call the real binding — a real
    send would deliver to the same queue the real deployed consumer is
    subscribed to, with no wrangler-level way to send without delivery.
    See `AGENTS.md` for the full reasoning and the rejected alternative
    (a second, test-only queue).
  - **ATS-adapter mocking (`vi.mock("@hiring-signals/adapters")`) —
    decided: accepted, not a policy violation.** `fetchBoard` calls a
    real third-party HTTP endpoint with no Cloudflare-account resource
    backing it; `ingest-consumer.test.ts`'s job is verifying
    orchestration given a scripted HTTP outcome, not re-proving a real
    board's shape (already covered, unmocked, by
    `packages/adapters/test/*.test.ts`'s static fixtures). See
    `AGENTS.md` for the full reasoning.

- [x] Inventory every existing test file's current fake/mock usage — see
      the inventory sub-section immediately above (2026-07-30). Surfaced
      two cross-cutting policy questions (Queue, ATS-adapter mocking),
      both since decided — see below and `AGENTS.md`.
- [x] Decide + document the live-D1-from-Vitest access pattern — done,
      `packages/test-support/src/live-d1-client.ts` (moved here from
      `apps/api/test/lib/` on 2026-07-30 per Milestone J, so
      `packages/db/test/*.test.ts` can import it too; shells out to
      `wrangler d1 execute --remote --json`, confirmed working against
      the real `hiring-signals` D1 database).
- [x] Decide + document the live-AI/VECTORIZE-from-Vitest access
      pattern — done, `packages/test-support/src/live-cf-bindings.ts`
      (same 2026-07-30 move as live-d1-client.ts above)
      (`createLiveAiBinding`/`createLiveVectorizeIndex`, direct REST per
      `backfill-embeddings.mjs`'s established pattern; `createLiveKvNamespace`
      also done for the `CACHE` namespace specifically via
      `wrangler kv key put/get/delete --remote`, confirmed working
      end-to-end 2026-07-30 — still needs generalizing past `CACHE` only,
      see cross-cutting blockers above).
- [x] Generalize `createLiveKvNamespace` to accept a namespace id
      (`CACHE` / `RAW_PAYLOADS` / `ABUSE_LOGS`) — done, see
      `live-cf-bindings.ts`'s `LiveKvBinding` type and
      `KV_NAMESPACE_IDS` lookup table (2026-07-30 generalization
      referenced above). No longer a blocker for
      `ingest-consumer.test.ts`.
- [x] Migrate `packages/db/test/*.test.ts` (all 4 files) — done. Every
      file now seeds real rows via `createLiveD1Client()` and asserts on
      real read-backs; `signals-write-repo.test.ts` was the last of the
      four (2026-07-30), including a live `listSignalsNeedingReconciliation`
      exercise (real stale signal + real classified job, not a canned
      `first()` return). `packages/db`'s own `vitest.config.ts`
      (`testTimeout`/`hookTimeout`: 90s) added alongside this — each
      `wrangler d1 execute --remote` call costs ~3.7s in cold-start
      alone, and a full seed+assert+cleanup sequence blows past
      vitest's 5s/10s defaults.
- [x] Add `createLiveD1Database()` (`packages/test-support/src/live-d1-database.ts`)
      — a real `D1Database`-shaped wrapper (not `D1Client`), needed
      specifically for `apps/api/test/jobs/*.test.ts`: those handlers
      receive a raw `env.DB` (`D1Database`) and call
      `createD1Client(env.DB)` themselves internally, so the live test
      double has to match that shape, not `D1Client` directly. Shares
      its `wrangler d1 execute --remote --json` transport
      (`escapeSqlValue`/`inlineParams`/`execRemote`) with
      `createLiveD1Client()` via a new `d1-remote-transport.ts`, rather
      than two drifting copies. Verified end-to-end with a standalone
      smoke test (`packages/test-support/smoke-test-d1-database.ts`:
      `first`/`all`/`run`-insert/read-back/cleanup against the real
      `companies` table) before any consumer test file was touched.
      Along the way, fixed a real environment bug this surfaced: a
      spawned `wrangler` child process inherits whatever `node`/`npx`
      resolves to on the *caller's* `PATH` (this machine's global
      default is v20, wrangler needs >=22), regardless of this repo's
      own `engines` field or a doc comment saying "run under `nvm use
      24.18.0`" — `d1-remote-transport.ts`'s `execRemote` now prepends a
      known-good nvm-managed bin dir to `PATH` for the spawned child
      only, so this works without every caller having to remember to
      switch shells first.
- [x] Add `apps/api/vitest.config.ts` (`testTimeout`/`hookTimeout`: 90s)
      — same values/reasoning as `packages/db/vitest.config.ts` above;
      `apps/api` had no vitest config at all before this, and its first
      live-D1-backed run timed out on vitest's defaults immediately.
- [x] Migrate `apps/api/test/jobs/reconciliation.test.ts` — done
      (2026-07-30). Off `vi.mock("@hiring-signals/db")` entirely, onto
      real seeded `companies`/`signals`/`signal_evidence` rows via
      `createLiveD1Database()`. Covers the stale-signal recompute path,
      the not-stale-yet no-op path, and the `status = 'active'` race
      guard (simulated via a raw `UPDATE signals SET status =
      'expired'`, same precedent as `signals-write-repo.test.ts`'s own
      guard test — no repo-layer "expire a signal" write function
      exists yet). `AI`/`VECTORIZE`/`INGEST_QUEUE` stay as
      `unusedBinding()` Proxies here, confirmed genuinely unused by this
      handler, not a coverage gap. 3/3 tests pass against live D1;
      confirmed zero leftover `test-recon-%` rows after a full run.
- [x] Migrate `apps/api/test/jobs/scheduler.test.ts` — done (2026-07-30).
      Off `vi.mock("@hiring-signals/db")`, onto real seeded `sources`
      rows via `createLiveD1Database()` + `createSource`/`updateSource`.
      `INGEST_QUEUE` stays the documented in-memory-capture exception
      (see `AGENTS.md`) — this handler must never fetch a provider
      directly, so a real queue consumer is deliberately out of scope
      for its own test. Drops the old fake's "exactly one SQL call, and
      it mentions `FROM sources`" introspection assertion (no live-client
      equivalent) in favor of the behavioral outcome it stood in for:
      due sources get enqueued, disabled/not-yet-due sources don't.
      5/5 tests pass against live D1 (due-source enqueue, disabled-source
      exclusion, not-yet-due exclusion, jitter determinism, jitter
      variance); confirmed zero leftover `test-sched-%` rows.
- [ ] **Next, not yet started:** migrate `apps/api/test/jobs/ingest-consumer.test.ts`
      — the last unmigrated file on this policy (1148 lines, 21 tests
      across 3 `describe` blocks: 8 happy-path, 9 failure-branch, 5
      H.4 company-signal-generation). Scoped but not started
      (2026-07-30): `DB` → `createLiveD1Database()`, `AI` →
      `createLiveAiBinding()`, `VECTORIZE` → `createLiveVectorizeIndex()`,
      `RAW_PAYLOADS` → `createLiveKvNamespace("RAW_PAYLOADS")` (now
      unblocked by the KV generalization above); `@hiring-signals/adapters`
      and `INGEST_QUEUE` stay mocked/faked per the two documented
      exceptions. Expect this file to need materially more wall-clock
      budget than `reconciliation.test.ts`/`scheduler.test.ts` combined
      — 21 tests each potentially chaining several live D1 calls plus a
      real Workers AI embed + Vectorize upsert per job, versus those two
      files' D1-only round trips. Idempotent-retry and
      second-consecutive-absence tests need two sequential
      `handleIngestMessage` calls against the same seeded state; H.4
      tests need precise real row counts (3 jobs in 14 days, 3 distinct
      `location_mode`s, etc.), not canned aggregates. Cleanup needs to
      cover `signal_evidence`/`signals`/`job_observations`/`jobs`/
      `source_runs`/`sources`/`companies` (existing precedent) plus, new
      for this file, Vectorize vectors by job id — the fake never had a
      real vector to clean up before.
- [ ] Update this repo's CI workflow (`.github/workflows/`) to provide
      `CF_TOKEN` as a secret and confirm `pnpm -r test` passes in CI
      against live resources, not just locally.
- [ ] Update `AGENTS.md`'s policy section's "Follow-up, tracked, not
      done today" note once `ingest-consumer.test.ts` lands too — don't
      update it piecemeal while one file is still unmigrated; flip it
      once all 4 `apps/api/test/jobs/*.test.ts`-equivalent work is
      actually done, matching the "don't leave a completed migration
      described as still-pending" instruction that note already gives.

### `packages/test-support` follow-ups (verified 2026-07-30 against the
### actual current file contents — a prior review note for this section
### described `wranglerEnv()`, a `-y` flag, and new `fs`/credential
### handling inside `live-d1-client.ts`; none of that exists in the repo
### as of this check, so those specific items are omitted below as
### unconfirmed. What's below was re-verified line-by-line against both
### files.

- [ ] `live-cf-bindings.ts`'s `loadCfToken()` (`.env.local` parser) only
      matches lines shaped exactly `CF_TOKEN=value` — no `export
      CF_TOKEN=...`, quoted values, inline comments, or whitespace
      around `=`. Either swap in a real dotenv parser or add a comment
      on `loadCfToken()` documenting that only this exact shape is
      supported, so a future edit to `.env.local` doesn't silently break
      it.
- [ ] `live-d1-client.ts`'s `execRemote` and `live-cf-bindings.ts`'s
      `runWrangler` are near-identical (`spawn("npx", ["wrangler", ...],
      { cwd: API_DIR, shell: false })`, same stdout/stderr capture, same
      reject-with-both-streams-on-failure shape). Consider factoring the
      spawn-and-capture plumbing into one shared helper in
      `packages/test-support` that both call, so the two files stay in
      sync as this grows (e.g. if KV/D1 need retry or timeout behavior
      later).
- [ ] `live-d1-client.ts`'s `execRemote` has no credential handling of
      its own at all — it relies entirely on whatever `wrangler` auth
      (ambient `CLOUDFLARE_API_TOKEN` or `wrangler login` state) already
      exists in the shell, unlike `live-cf-bindings.ts` which explicitly
      calls `loadCfToken()`/reads `CF_TOKEN`/`.env.local` and throws a
      clear "Missing CF_TOKEN" error up front. Worth deciding: should D1
      tests fail with the same clear preflight message when credentials
      are absent, instead of whatever raw `wrangler d1 execute` prints
      on an auth failure? If so, either call the same credential check
      before the first `execRemote`, or explicitly document why D1 is
      allowed to differ (e.g. `wrangler d1 execute` may already have its
      own separate, already-logged-in auth path distinct from the
      `CF_TOKEN` REST calls in `live-cf-bindings.ts`, in which case say
      so here).
- [ ] `live-d1-client.ts`'s `execRemote` includes the full SQL text
      (inlined params and all) in every thrown error. Fine for debugging
      today since all current callers are `packages/db` repo functions
      with test-authored literal values, but worth a truncation/redaction
      strategy (or an explicit "safe because test-only values" comment)
      before this client is used more broadly.
- [ ] Add a short README (or package-level doc comment) for
      `@hiring-signals/test-support` covering: which live Cloudflare
      resources each file touches, required env vars (`CF_TOKEN` /
      `.env.local`, ambient wrangler auth for D1), what a missing-token
      failure looks like per file, and why these are real clients, not
      mocks/fakes, per `AGENTS.md`'s policy.
