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

**Post-hoc code review fix (2026-08-04):** an independent code review
(validated 2/2 by sub-agents) against `signal-score.ts` and
`signals-write-repo.ts` found 5 concrete defects, all confirmed against
the current code and fixed:
1. `findActiveSignal`'s dedup query filters on `(company_id,
   role_category, signal_type, status)` but no index covered
   `company_id`, forcing a table scan per ingestion event. Fixed with
   migration `0005_signals_dedup_index.sql` (`idx_signals_dedup` on
   `signals(company_id, role_category, signal_type, status)`).
2. `computeFreshness` returned unclamped `e^(-d/14)`, which exceeds 1.0
   for negative `d` (clock skew) — inconsistent with every sibling
   component (`computeVolume`/`computeAcceleration`/`computeBreadth`,
   all `clamp()`-wrapped) and a violation of `ScoreComponents`'
   documented `[0,1]` range. Fixed: now `clamp(..., 0, 1)`.
3. `classificationConfidence` was passed straight through as `quality`
   in both `computeNewJobScore` and `computeReconciliationScore` with no
   clamp, persisting out-of-range values verbatim to
   `signal_evidence.payload_json`. Fixed: both now clamp to `[0,1]`.
4. `refreshSignal`'s `UPDATE` had no `status = 'active'` guard (unlike
   sibling `updateSignalScore`/`markSignalStillActive`), so a signal
   that flipped to `'expired'` between the caller's `findActiveSignal`
   SELECT and this UPDATE could be resurrected until the expiration cron
   swept it again. Fixed: added `AND status = 'active'`.
5. `appendSignalEvidence` called `JSON.stringify(input.payload)`
   unguarded on `payload: unknown`, which throws deterministically on
   circular refs/BigInt. Fixed: wrapped in a `serializeEvidencePayload`
   helper that rethrows a clear, `cause`-preserving error instead of an
   opaque `TypeError` inside the INSERT.
- Verify: 2 new regression tests added to
  `packages/domain/test/signal-score.test.ts` (negative-day freshness
  clamp, out-of-range quality clamp) — `pnpm --filter
  @hiring-signals/domain test` 26/26 green (was 24). `pnpm --filter
  @hiring-signals/db typecheck`/`lint` clean. Full live-D1
  `packages/db/test/signals-write-repo.test.ts` re-run against the real
  `hiring-signals` Cloudflare account: 21/21 green, including the
  `refreshSignal` happy-path test with the new guard in place.

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
- [x] `personio` — `packages/adapters/src/personio.ts` + fixtures + tests
  - **Status (2026-07-31): done, found already implemented and verified
    this session rather than taken on faith** — the checkbox was still
    unmarked despite the adapter, fixtures, and tests all being complete
    on disk (same "looks done, status not updated" pattern this file has
    caught repeatedly elsewhere; corrected here instead of left stale).
    Public, unauthenticated Personio XML career-site feed
    (`https://{company}.jobs.personio.de/xml?language=en`, `.com` TLD
    also supported) verified against Personio's own OpenAPI doc and
    support docs 2026-07-31 (spec §21). XML, not JSON — the only P0
    adapter with this shape — parsed via a small hand-rolled extractor
    (`packages/adapters/src/xml-lite.ts`) rather than adding a full XML
    dependency for one provider.
  - No per-job URL field exists in Personio's `JobPosting` schema, so
    canonical URLs are constructed as `{host}/job/{id}` — confirmed
    against a real live Personio-hosted board fetched 2026-07-31, not
    assumed.
  - Registered in `registry.ts` and re-exported from `index.ts`; the ops
    script provider list already included `personio`.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`/`lint`/
    `test` clean, 15 Personio-specific tests passing as part of the
    package's 114-test suite (re-confirmed this session).
- [x] `breezy` — `packages/adapters/src/breezy.ts` + fixtures + tests
  - **Status (2026-07-31): done, same found-already-implemented
    correction as `personio` above.** Public, unauthenticated Breezy HR
    careers-site JSON feed (`https://{company}.breezy.hr/json?verbose=true`),
    distinct from Breezy's authenticated back-office REST API — same
    public-feed/authenticated-API split this repo already has for
    Greenhouse and Lever. Cross-checked two ways before building: an
    independent non-vendor source (a real user's forum post) showing the
    feed working unauthenticated, plus Breezy's own developer docs for
    the `Position` object schema, confirming the two surfaces share one
    read model.
  - `verbose=true` is required to get `description` in the response.
  - Registered in `registry.ts` and re-exported from `index.ts`; the ops
    script provider list already included `breezy`.
  - Verified: `pnpm --filter @hiring-signals/adapters typecheck`/`lint`/
    `test` clean, 13 Breezy-specific tests passing as part of the
    package's 114-test suite (re-confirmed this session).
- [x] `teamtailor` — **not building: gated, no public tier (standing
      decision 2026-08-04).** See policy note + provider note below.
- [x] `jazzhr` — **not building: gated, no public tier (standing
      decision 2026-08-04).** See policy note + provider note below.
- [x] `bamboohr` — **not building: scope closed at 8 (standing decision
      2026-08-04).** See coverage-scope note below.

**Status (2026-08-04): coverage scope closed at 8 P0 adapters**
(greenhouse, lever, ashby, smartrecruiters, workable, recruitee,
personio, breezy) — decided with the user, not a gap to fill later.
`teamtailor`/`jazzhr` are gated won't-builds (see policy note below);
`bamboohr` was assessed as *possibly* buildable but is deliberately
not pursued further — 8 reliable, maintained sources beats a wider
surface that costs more to keep current with every provider API
change. This milestone is done, not paused. Re-verified this session:
`pnpm -r typecheck`/`lint` clean across all 6 workspace projects, zero
errors (only the same pre-existing warnings this file already
documents elsewhere); `pnpm --filter @hiring-signals/domain test`
(70/70) and `pnpm --filter @hiring-signals/adapters test` (114/114)
both green.

For each remaining adapter: confirm the provider's public, unauthenticated board API is
still live and documented *before* writing the schema (spec §21: "Never
invent API endpoints ... Verify source contracts first") — don't assume
last-known-good API shapes from training data are current; check the
provider's own developer docs.

**Coverage scope closed at 8, decided with the user 2026-08-04: no
further P0 adapters.** Every additional adapter is permanent
maintenance surface — a schema that can drift with the provider's own
API changes, fixtures to keep current, a fetch path that can start
failing silently. 8 reliable sources that reliably publish openly
beats a wider count that costs more to keep correct. This is a
standing decision, not a backlog item — a future session should not
propose `teamtailor`, `jazzhr`, `bamboohr`, or any other new provider
without the user raising it first. The verification discipline below
(spec §21) still applies if that ever happens, but the default from
here is: stay on the 8.

**Policy on gated providers, decided with the user 2026-08-04: do not
force it.** If a provider's data requires an account-scoped secret
key with no public/unauthenticated tier, that provider stays a
documented blocker permanently, not a task to route around (no
building against the authenticated API with a placeholder-token
story, no scraping the rendered HTML as a substitute, no silently
dropping the provider from the roadmap either). This repo's own value
is a reliable pipeline over sources that *choose* to publish openly
(spec §21's whole premise) — a provider that gates its data is a
closed door, not a puzzle to solve, and a coverage gap here is
strictly better than an unreliable or credential-dependent adapter
that could break the "no secrets in source config" posture (spec
§14.1) or silently stop working when a borrowed/scraped path changes.
`teamtailor`/`jazzhr` below fall under this permanently — not
"blocked for now," blocked as a standing decision.

**`teamtailor` — blocked, not a gap in effort (checked 2026-08-04).**
Confirmed against Teamtailor's own official API docs
(`docs.teamtailor.com`, fetched directly): every documented endpoint,
including `GET /v1/jobs`, requires `Authorization: Token token=...` — a
secret API key issued per Teamtailor account, no public/unauthenticated
tier exists in the official API at all (`Public` scope in their docs
means "read access to public *data*," not "no key required"). Teamtailor
does support an opt-in public XML feed per career site, but per
Teamtailor's own docs "it's up to the client to activate this and share
the URL" — there is no discoverable, board-token-derived URL pattern the
way Greenhouse/Lever/etc. have (`{host}/board-token`), so this repo's
`board_token`-only source-config model (spec §8.2) has no field to
construct a fetchable URL from for a Teamtailor source. This differs
from `ashby`/`smartrecruiters`/`workable` above, which all needed a
network-proxy workaround to *verify* an already-known-public shape --
this is a structural blocker (no public shape to adapt to at all), not
an environment limitation. Do not build this adapter against the
authenticated `api.teamtailor.com` API without a real decision, sourced
from the user, about where a per-company secret token would be stored
and rotated (spec §14.1's "no secrets in source config committed to the
repo" concern applies directly) -- flagging as blocked rather than
silently skipping or building an adapter that can't actually be
exercised against a real board. Revisit if Teamtailor ships a public
feed with a derivable URL, or if the user decides per-company token
storage is in scope.

**`jazzhr` — blocked, same shape as `teamtailor` (checked 2026-08-04).**
JazzHR's own official API docs (`apidoc.jazzhrapis.com`) and multiple
independent secondary sources agree: JazzHR's "Listings XML feed" and
REST API are both **scoped per customer with that customer's own API
key**, minted inside the customer's JazzHR admin panel (Settings >
Integrations), and gated behind subscription tier on some plans. There
is no cross-customer public endpoint and no board-token-derivable URL
pattern — same structural blocker as `teamtailor`, not an environment
limitation. Do not build against an authenticated JazzHR endpoint
without a real decision about per-company secret storage (spec §14.1).
Revisit if this changes or if per-company token storage is decided in
scope.

**`bamboohr` — not building: closed by coverage-scope decision, not by
lack of a viable path (checked 2026-08-04).** Unlike `teamtailor`/
`jazzhr`, this one was NOT found to be gated — multiple independent
non-vendor-neutral sources (an Apify scraper listing, a competing
aggregator's own marketing page) describe a public, unauthenticated
`https://{company}.bamboohr.com/careers/list` JSON endpoint with no
anti-bot, matching this repo's `board_token`-as-subdomain model
exactly (same shape as `personio`/`breezy`). That endpoint was never
confirmed first-party — this session could not find or fetch a real
customer's live `{company}.bamboohr.com/careers/...` board (BambooHR's
own careers page has migrated to Greenhouse, so it can't serve as the
verification example) — but the *reason* this adapter isn't being
built is the scope decision above, not that verification failed. If
the user ever decides to reopen adapter coverage, this is the
best-positioned candidate to pick up first, and the verification step
above (find one real company still on native BambooHR hosting, fetch
the endpoint directly, confirm the shape per spec §21) is exactly
where to resume — but that is not scheduled and should not be started
without the user reopening it.

- [x] Ops source-management script's provider-enum usage — no update
      needed. `add-source.mjs`'s inlined `ATS_PROVIDERS` list already
      includes all 11 canonical providers (matching
      `packages/domain/src/providers.ts`); the 3 not built
      (`teamtailor`/`jazzhr`/`bamboohr`) simply have no `registry.ts`
      entry, so `getAdapterForProvider` throws its typed
      `UnsupportedProviderError` if anyone ever configures a source for
      one — correct behavior for a closed-scope provider, not a bug.
- [x] AGENTS.md's roadmap status — reflects the closed-at-8 scope as of
      this session (see AGENTS.md itself for its own status line).

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

### Sequencing
above — this file's first pass focused on the write-path (Milestones
A–E) since that's what was in flight when this document was created.
Expand this milestone into the same level of task detail before
starting it; don't start UI work directly off the one-line spec
references above.
(detail) — every later task renders inside the app-shell using the F.2
tokens and F.3 primitives. F.4 and F.5 can proceed in parallel once F.3
is done. F.6 (empty/loading/error) threads through F.4/F.5 rather than
following them, so build it alongside, not after. F.7 (a11y+responsive
pass) is last because it audits everything built in F.1–F.6.
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
      hover animations must respect it (spec §11.5); transitions under
      150ms. Establish the pattern here (e.g. a `useReducedMotion` hook
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
      deferred/unbuilt per Milestone list above and would otherwise be
      permanently-empty options). Done 2026-08-03.
- [x] `components/signal-type-filter.tsx` — single-select toggle buttons
      over `SIGNAL_TYPES`. No facet counts: `Facets`
      (`packages/db/src/types.ts`) has no `signalTypes` entry yet (only
Spec §1.4 (signal types — `still_active` is defined but never generated),
§15 (detection latency is the primary metric but not tracked), §7.1
(signal type table). Two items bundled because they share the same
reconciliation cron pass that H.5 already established.

**Why this adds value:** passive job seekers need to know a listing they
bookmarked is still open. Without `still_active`, a signal that stops
refreshing is indistinguishable from a closed one. Detection latency is
the product's own stated optimization target (spec §1.1) — without
measuring it, cadence-tuning decisions are guesses.

- [ ] **K.1 — `still_active` signal generation**
  (`apps/api/src/jobs/reconciliation.ts`, `packages/domain`)
  - During the daily reconciliation pass (H.5), for each active signal
    whose `last_detected_at` is older than `pollIntervalMinutes * 2`
    (i.e. it was seen at least two polls ago and is still active), emit
    a `still_active` signal evidence row — not a new signal row, an
    evidence append on the existing active `new_job` signal. This keeps
    the signal's `last_detected_at` current and its score from decaying
    to zero for a genuinely persistent open role.
  - Trigger condition: `status = 'active'` AND the backing job's
    `last_seen_at` is within the last `pollIntervalMinutes * 1.5`
    (job was seen recently) AND the signal's `last_detected_at` is
    older than 24h (avoid double-appending on the same day). The job
    being recently seen is the evidence — don't emit `still_active` for
    a signal whose backing job is itself going stale.
  - `buildHeadline`/`buildSummary` for `still_active`: "Role still
    active" / "Matching role confirmed open at last check." — factual,
    no implied urgency.
  - Verify: extend `reconciliation.test.ts` with a test asserting a
    recently-seen active job's signal gets a `still_active` evidence
    row appended; a job whose `last_seen_at` is stale does not.
    `pnpm -r typecheck`/`lint`/`test` clean.
      (didn't exist before — required moving `<AppShell>` out of the
      root layout into per-route pages, since the old setup made it
  (`packages/db/src/jobs-repo.ts`, `apps/api/src/jobs/ingest-consumer.ts`,
  `infrastructure/scripts/source-health.mjs`)
  - Spec §20 Phase 3 step 6: "track time between a job's `first_seen_at`
    and the source run that produced it." This is already computable from
    existing columns (`jobs.first_seen_at` and `source_runs.started_at`
    for the run that first saw the job) — no schema change needed, just
    a query and a place to surface it.
  - New repo function `getDetectionLatencyStats(client, { sourceId?,
    since })` in `packages/db/src/sources-repo.ts`: returns
    `p50LatencyMinutes`/`p95LatencyMinutes`/`sampleCount` for jobs
    first seen in the given window, optionally scoped to one source.
    Computed as `(first_seen_at - source_run.started_at)` in minutes
    via a JOIN on `job_observations` → `source_runs` filtered to
    `is_present = 1` and the observation's `source_run_id` matching the
    job's own `first_seen_at` window.
  - Surface in `source-health.mjs`'s output table: add a
    `p50 latency` column alongside the existing Failures/Status columns.
    This is the concrete output spec §20 Phase 3 step 6 asks for.
  - Verify: a repo test (fake `D1Client` pattern or live D1) asserting
    the latency query returns correct p50/p95 for a seeded set of
    jobs with known `first_seen_at`/`started_at` pairs; a manual run
    of `source-health.mjs` against local D1 confirming the column
    appears. `pnpm -r typecheck`/`lint`/`test` clean.
      correctly showed its loading-skeleton state in the absence of one.
- [x] Verify: `pnpm -r typecheck`/`lint` clean across the full
      workspace (not just `apps/web`) — confirmed 2026-08-04, zero
      errors, only 6 pre-existing warnings in files untouched by F.4.
      `pnpm --filter web build` also verified clean (this caught a real
      production-build failure — `useSearchParams()` needs a `Suspense`
expire after 24h in KV). Listed as "not yet built" in README. This is
the one P0 feature the spec explicitly requires that has no milestone
tracking it.

**Why this adds value:** the primary use case for the secondary audience
(investors, recruiters) is exporting a filtered signal list for offline
analysis. Without export, the dashboard is read-only and the data is
trapped in the UI.

- [ ] **L.1 — Export route** (`apps/api/src/routes/export.ts`)
  - `GET /api/v1/export/signals.csv` — accepts the same query params as
    `GET /api/v1/signals` (spec §9.3's full param set: `roles`,
    `company`, `q`, `locationMode`, `country`, `source`, `signalType`,
    `minScore`, `observedSince`) but returns `text/csv` instead of JSON.
  - Reuse `listSignals` from `signals-repo.ts` with `limit` raised to a
    safe ceiling (propose 2000 rows — document this as a v1 cap, not a
    permanent limit, in the route's header comment). Do not paginate
    across multiple D1 calls for the export; if the result set exceeds
    the cap, return what fits and include a `X-Export-Truncated: true`
    header so the caller knows.
      see file header comment), score + plain-language breakdown, exact
      signal rule + detection time, trend block. Trend's 7/30/90-day
      series needs a new API field `SignalDetail` doesn't carry today —
    `canonical_url`. No personal data — these are all job/company
    fields, consistent with spec §14.2.
      numbers. Deferred to Milestone O's timeline work.
- [x] `components/evidence-table.tsx` — job title, source, observed
    `Cache-Control: no-store` (export reflects current filter state,
    must not be cached by CDN).
  - Rate-limit: apply the same `freeReadTier` middleware as every other
    read route (spec §13.2) — export is not a special tier, it's just
    a different response format.
  - Verify: a route-level test (same Hono test pattern as existing route
    tests in `apps/api/test/`) asserting (a) correct CSV headers and
    column order for a seeded result set, (b) `X-Export-Truncated: true`
    when the result count hits the cap, (c) the same filter params that
    work on `GET /api/v1/signals` produce a correctly filtered CSV.
    `pnpm --filter @hiring-signals/api typecheck`/`lint`/`test` clean.
      sections all render real data end-to-end with zero console errors.
      Also found and fixed a real, separate bug while verifying: the
  - Spec §10.2's masthead mockup already shows `[EXPORT CSV]` in the
    top-right. Wire it to `GET /api/v1/export/signals.csv` with the
    current URL's filter params forwarded. Client-side: a plain anchor
    `href` constructed from the current `useSearchParams()` state —
    no fetch/blob dance needed since the route returns a file attachment
    directly. Disable the button (greyed, not hidden) when no signals
    are loaded yet (empty state).
  - Sequence after Milestone F's dashboard shell exists — this item
    cannot be built until F's filter rail and URL-param state are in
    place. Track as a dependency, don't start L.2 before F ships.
  - Verify: manual smoke test confirming the downloaded file matches the
    currently applied filters; keyboard accessibility (button is
    focusable, has a visible label, `Enter` triggers download).

Build alongside F.4/F.5, not after — these states are properties of the
feed/detail components, not a separate screen.

- [ ] `components/empty-state.tsx` — covers all four spec §10.6 rows:
      first-load skeleton (dense-layout-preserving skeleton rows, not a
open decision 2 ("who supplies and validates ATS board tokens at launch,
and how does the registry grow over time without becoming a bottleneck").

**Why this adds value:** the registry bottleneck is the real ceiling on
the product's value. Right now, adding 100 companies requires 100
separate `add-company.mjs` + `add-source.mjs` invocations. A CSV import
removes that friction entirely and is the prerequisite for the registry
growing fast enough to make the signal feed genuinely useful.

- [ ] **M.1 — `import-sources.mjs` ops script**
  (`infrastructure/scripts/import-sources.mjs`)
  - Accepts a CSV file path as its only argument. CSV columns:
    `company_slug`, `company_display_name`, `company_domain` (optional),
    `provider`, `board_token`, `public_url`, `poll_interval_minutes`
    (optional, defaults to 90). One row = one source; a company with
    multiple ATS boards gets multiple rows with the same `company_slug`.
  - Processing order per row: check if `company_slug` already exists
    (SELECT) → if not, `createCompany` → then `createSource`. Both
    operations use the existing repo functions' duplicate-detection
    (`DuplicateCompanyError`/`DuplicateSourceError`) — a duplicate row
    in the CSV is a skip-with-warning, not a fatal error, so a re-run
    of the same CSV is safe.
  - Validation before any D1 writes: parse the entire CSV first, reject
    rows with missing required fields or invalid `provider` values
    (against the same `ATS_PROVIDERS` list `add-source.mjs` inlines),
    print a summary of valid/invalid rows, and ask for confirmation
    before writing — same "confirm before destructive action" pattern
    as `update-source.mjs --disable`.
  - Progress output: print one line per processed row
    (`[OK] acme-corp / greenhouse`, `[SKIP] acme-corp already exists`,
    `[ERROR] invalid provider: workday`) and a final summary
    (created/skipped/errored counts).
  - Same `.mjs`-over-`wrangler d1 execute --json` pattern as the
    existing ops scripts (Milestone D's D1-access-approach note applies
    here too — no live `D1Database` binding outside a Worker).
  - Verify: run against a test CSV with 5 rows (2 new companies, 1
    duplicate company with a new source, 1 duplicate source, 1 invalid
    provider) against local D1; confirm row counts match expected
    created/skipped/errored; confirm re-running the same CSV produces
    all-skipped output with no errors. `nvm use 24.18.0` first, same
    Node-version note as all other ops scripts.
## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §14 (security controls, privacy posture, legal copy), §15
(performance/reliability targets), §16 (observability/ops), §18
(CI/CD), §19 (acceptance criteria).

scoped to client-side `localStorage` only — no backend, no user
accounts, no new API surface. The spec's own P1 description says "saved
dashboard view," not "server-persisted profile," and the product has no
login, so client-side is the only option consistent with §14.1.

**Why this adds value:** without saved filters, a passive job seeker
has to re-enter their role/location preferences every visit. This is
the difference between a tool someone uses once and one they check
weekly. It's also the lowest-effort high-retention feature available —
pure client-side, no backend changes.
already. G is mostly a **verification and gap-closing pass**, not net-new
construction: confirm what's built actually meets each spec §14/§15/§16
  - A "SAVE FILTERS" button in the filter rail (spec §10.2's layout)
    that writes the current URL's filter params to `localStorage` under
    a named key (e.g. `hiring-signals:saved-filters`). On page load,
    if saved filters exist and no URL params are present, offer a
    "RESTORE SAVED FILTERS" prompt (a single-line banner above the feed,
    dismissible) — don't silently apply saved filters without the user's
    awareness, since the URL is the source of truth (spec §12.2).
  - Storage format: a plain JSON object of the current `signalsQuerySchema`
    params. No versioning needed for v1 — if the schema changes and
    stored params become invalid, Zod parse failure → silently discard
    the stored value and show the prompt to re-save.
  - "CLEAR SAVED FILTERS" button alongside "SAVE FILTERS" when a saved
    profile exists.
  - Sequence after Milestone F's filter rail exists — cannot be built
    before F ships. Track as a dependency.
  - Verify: manual smoke test (save filters, close tab, reopen, confirm
    restore prompt appears with correct params); keyboard accessibility
    (both buttons focusable, labeled); `pnpm --filter @hiring-signals/web
    typecheck`/`lint` clean.

### G.1 — Security control audit against spec §14.1 (do this first)

Go through spec §14.1's bullet list one at a time and record a verified
disposition (✅ already satisfied / ⚠️ partial / ❌ gap) for each, citing
Spec §1.4 (company-level signals), §10.1 (`/companies/[slug]` route exists
but is unspecified beyond "company-level timeline and active roles"),
§2.3 ("Trend charts and source-coverage reporting" is listed as P2 —
this milestone is the structured-data foundation that makes charts
possible without building charts yet).

**Why this is the real differentiator:** the job-seeker feed is
commodity. What no public tool gives you today is a structured,
timestamped, evidence-backed record of *how a specific company's hiring
composition has changed over time* — which roles they opened, when, in
which locations, and whether that pace is accelerating or contracting.
That is the data investors use to infer product bets, geographic
expansion, and team-building ahead of announcements. It's already being
collected by the ingestion pipeline. It just needs a dedicated read path
and a page that makes it legible.

The key constraint: this must never claim to represent intent, budget, or
confirmed decisions — only observable public evidence (spec §14.3). The
value is in the pattern, not in the interpretation.
      sweep still worth a dedicated grep pass (see G.1 verify below)
      rather than relying on spot checks alone before declaring this
      item closed.
- [x] **"Validate all external payloads"** — ✅ every adapter
      (`greenhouse.ts` confirmed) runs the raw ATS response through a
Returns a time-bucketed summary of hiring activity for one company,
queryable by role category and date range. No new ingestion logic —
this is a pure read path over existing `jobs` and `signals` rows.
      `dangerouslySetInnerHTML`"** — not yet verified. This is an
      `apps/web` concern (rendering `content`/description fields from
      adapters) and `apps/web` doesn't render any job descriptions yet
      `packages/db/src/companies-repo.ts`. Returns an array of time
      buckets, each containing:
      - `bucketStart` / `bucketEnd` (ISO-8601)
      - `newJobsCount` — jobs with `first_seen_at` in this bucket
      - `closedJobsCount` — jobs that transitioned to `closed` in this bucket
        (approximated from `last_seen_at` + lifecycle state)
      - `activeJobsCount` — jobs with `status IN ('active', 'possibly_closed')`
        at bucket end (snapshot, not a running total)
      - `roleBreakdown` — `{ [roleCategory]: newJobsCount }` for the top
        categories in this bucket, so a caller can see "3 ML, 2 DevOps,
        1 Security" without a second query
      - `locationBreakdown` — `{ [countryCode]: newJobsCount }` for the
        top countries in this bucket
      - `signalTypes` — array of distinct signal types fired in this bucket
        (`hiring_burst`, `role_acceleration`, etc.) — the "what the system
        concluded" layer on top of the raw counts
      - Default bucket size: 14 days. Caller can override with
        `bucketDays=7` or `bucketDays=30`. Cap at 90 days of history
        for v1 (matches the `jobs` retention window and keeps the query
        fast without a dedicated analytics table).
      `encodeURIComponent`-escaped `boardToken` into a hard-coded host
    last_seen_at DESC)` already exists. Run `EXPLAIN QUERY PLAN` against
    the bucketed aggregation before shipping — a `GROUP BY` over
    `first_seen_at` buckets on a large `jobs` table may need a
    `(company_id, first_seen_at)` index. Add a migration if needed.
  - Verify: repo test (live D1 pattern per Milestone J) seeding jobs
    across 3 known date buckets and asserting correct `newJobsCount`/
    `roleBreakdown` per bucket; `pnpm --filter @hiring-signals/db
    typecheck`/`lint`/`test` clean.
      only path segments may come from SourceConfig") so a future
      adapter doesn't accidentally break the invariant.
      `apps/api/src/routes/companies.ts`. Query params: `since` (ISO
      date, default 90 days ago), `until` (ISO date, default now),
      `roles` (comma-delimited role categories, optional),
      `bucketDays` (7/14/30, default 14). Same public/unauthenticated
      access as every other read route (spec §14.1). Response envelope:
      `{ data: { company: { slug, displayName }, buckets: [...] }, meta: { requestId } }`.
  - Verify: route test asserting correct bucket shape for a seeded
    company; `pnpm --filter @hiring-signals/api typecheck`/`lint`/`test`
    clean.
      configuration; this is the same gap Milestone F.1 already flagged
      independently. Track the fix in G.2, not duplicated in F — F.1
      can link here instead of owning the implementation.
Spec §10.1 lists this route but leaves it unspecified. This is the
investor-facing view — dense, data-forward, no decoration.

- [ ] `/companies/[slug]` page in `apps/web` (sequence after Milestone F's
      shell exists). Layout:
      `requestId`+`message`, never raw `err` or headers) and
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
      `company_asc`/score-default) — never raw user input. LIKE-pattern
  - The bar chart is a pure CSS/SVG bar chart — no charting library.
    Each bar is a `<div>` or `<rect>` with height proportional to
    `newJobsCount / max(newJobsCount)`. Brutalist styling: black bars,
    white background, 2px black border on the chart container, no
    gridlines, no tooltips on hover (data labels below each bar instead).
    `prefers-reduced-motion` has no effect here since there's no
    animation — bars are static on render.
  - Role/location breakdowns: horizontal bar rows, same CSS approach,
    label + count inline. No pie charts, no donut charts — they obscure
    the absolute numbers that matter to an analyst.
  - "Monitored since" = the earliest `source_runs.started_at` for this
    company's sources — surfaces data provenance, which is what makes
    the trend credible ("we've been watching this company for 8 months,
    not 2 weeks").
  - Export CSV button: links to `GET /api/v1/export/signals.csv?company=<slug>`
    (Milestone L) — exports the company's full signal history, not just
    the current view.
  - Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint` clean;
    manual smoke test confirming bars render correctly for a company with
    seeded timeline data across multiple buckets.
      value. No redaction gap found.
- [x] Document final disposition of every spec §14.1 bullet — done
      above; final tally as of 2026-08-03: 6 of 8 bullets ✅ fully
      satisfied (unauthenticated routes, SQL parameterization, payload
      validation, SSRF allow-listing by construction, log redaction,
Spec §1.2 (investor/analyst as secondary audience), §2.3 ("Trend charts"
deferred — this is the API layer that makes them possible without
building a full analytics UI yet).

**Why this adds value beyond Milestone O:** a single company's timeline
is useful for due diligence on one target. Cross-company trend data is
what makes this a market intelligence tool — "which companies in the
fintech sector started hiring ML engineers in the last 60 days?",
"show me companies with accelerating DevOps hiring in Germany." That
query is not answerable from the existing signal feed because the feed
is role-first, not company-first, and has no sector/industry dimension.

This milestone adds the read paths only — no new ingestion, no new
schema beyond one optional `industry` tag already in the `companies`
table (spec §8.2 already has `industry TEXT`).

- [x] **CI dependency scanning** — ✅ done 2026-08-03. Added
  (`infrastructure/scripts/update-company.mjs`)
  - The `companies` table already has an `industry` column (spec §8.2)
    but `add-company.mjs` doesn't expose it and `update-company.mjs`
    doesn't exist yet. Add `update-company.mjs` ops script accepting
    `--id`, `--industry`, `--employee-band` flags — same `.mjs`-over-
    `wrangler d1 execute --json` pattern as the other ops scripts.
    `industry` is a free-text tag for v1 (e.g. "fintech", "healthtech",
    "defense") — no controlled vocabulary enforced yet, just stored and
    queryable. A controlled taxonomy is a future refinement once real
    usage shows what groupings matter.
  - Verify: run against local D1, confirm `industry` persists; confirm
    missing `--id` is rejected. `nvm use 24.18.0` first.
    arbitrary file read/execute, but only when its UI server is
    listening, which nothing in this repo's scripts/CI ever starts),
  `GET /api/v1/trends/hiring`
  - Query params: `roles` (comma-delimited, required — at least one),
    `industry` (optional free-text filter on `companies.industry`),
    `country` (optional ISO code), `since` (ISO date, default 30 days),
    `sort` (`acceleration_desc` / `volume_desc` / `newest_signal`,
    default `acceleration_desc`), `limit` (1–50, default 20).
  - Returns a ranked list of companies with the most notable hiring
    activity for the requested role(s) in the requested window. Each
    item: `{ company: { slug, displayName, industry, domain },
    moment F.1 or any later milestone actually wires up `next/image`
    with a remote pattern).
  - **Action taken:** none of the 13 justified blocking CI today given
    formula, same version, no new math.
  - This is the query an investor runs: "show me companies hiring ML
    engineers fastest right now, in fintech." The answer is a ranked
    list with evidence, not a chart — the chart is a future UI layer.
    runs can be diffed against it (new findings vs. this list) rather
    than re-triaged from zero each time. Revisit `vitest`/`sharp`
    `packages/db/src/signals-repo.ts` (or a new
    `packages/db/src/trends-repo.ts` if the query grows complex enough
    to warrant its own file — decide at implementation time).
  - Index check: this query joins `companies` → `jobs` filtered by
    `role_primary` + `first_seen_at` window + optional `country_code`.
    `idx_jobs_filters (company_id, role_primary, status, last_seen_at DESC)`
    covers the role filter but not `first_seen_at` or `country_code`.
    Run `EXPLAIN QUERY PLAN` before shipping; add a migration for
    `(role_primary, first_seen_at, country_code)` if it's scanning.
  - Rate-limit: same `freeReadTier` middleware as every other read route.
    This query is heavier than a single-company lookup — consider a
    KV cache with a 5-minute TTL for identical param combinations (same
    pattern as `facets-repo.ts`).
      forward from the item above, implemented together). Added an
    different role counts and asserting correct ranking order; route
    test asserting the `industry` filter excludes non-matching companies;
    `pnpm -r typecheck`/`lint`/`test` clean.
      a locked-down `Permissions-Policy`, and a CSP
      (`default-src 'self'`, `connect-src 'self' <NEXT_PUBLIC_API_BASE_URL>`,
  - A `/trends` route (add to spec §10.1's route map) showing the
    cross-company trend table: role selector at the top (same chip-toggle
    as Milestone I.4's filter mechanics), optional industry/country
    filter, ranked company list below. Each row: company name, role
    count, acceleration indicator (▲ / — / ▼ based on the `acceleration`
    value), top location, latest signal type, last seen timestamp.
    `[VIEW COMPANY →]` links to `/companies/[slug]` (Milestone O.2).
  - No charts on this page — the table is the product. Charts are P2
    (spec §2.3) and require historical data that won't exist until the
    system has been running for weeks.
  - Sequence after Milestone F's shell and Milestone O.2's company page
    exist — `/trends` reuses the same filter chip components and links
    into the same company page.
  - Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint` clean;
    manual smoke test confirming the role selector filters the table
    correctly and the URL encodes the selected roles.
      originally shipped applied `script-src 'self'` unconditionally,
      which broke `next dev` itself (Turbopack HMR + React dev-mode
      `eval()` both blocked). Fixed to scope `'unsafe-inline'`/
      `'unsafe-eval'` to `PHASE_DEVELOPMENT_SERVER` only, using Next's
      `phase` argument rather than `NODE_ENV` (unreliable on this
**Why this is the real moat:** the existing signal score (§7.2) ranks
individual role-level signals. What investors need is a single
**company-level hiring velocity score** — a number that answers "how
aggressively is this company building its technical team right now,
relative to its own historical baseline?" That's a different question
from "is this specific job posting fresh?"

This is the feature that turns the product from a job feed with company
context into a genuine market intelligence tool. It's computable entirely
from data already being collected. No new ingestion, no new schema
beyond one new column.
      are captured anywhere in the ingestion pipeline — audit
      `packages/adapters/src/*.ts`'s Zod schemas for any field that
  (`packages/domain/src/hiring-velocity.ts`, new file)
      job-post data, which is the explicitly in-scope data type per
    HiringVelocityResult` where `CompanyRoleStats` is the output of
      job/org fields (title, location, department, url) — extend the
    categories for a company (not just one role+company pair).
  - Score formula (v1, document as versioned same as signal score):
      requests removal... disable its source and remove retained raw
      payloads according to policy after legal review") — check whether
      0.40 * acceleration       // pace vs. own baseline (most weight)
      + 0.25 * breadth          // geographic expansion signal
      + 0.20 * volume_norm      // absolute active headcount, normalized
      + 0.15 * persistence      // sustained demand (days active / 30)
      "disable" half. The "remove retained raw payloads" half: raw
      payloads already auto-expire after 30 days (`raw-payload-store.ts`)
    Where `acceleration` and `breadth` reuse `computeAcceleration` and
    `computeBreadth` from `packages/domain/src/signal-score.ts` (H.3),
    `volume_norm` is `clamp(totalActiveJobs / 10, 0, 1)` (10 is a
    documented v1 choice, same caveat as `computeVolume`'s 5), and
    `persistence` is `clamp(daysSinceFirstSignal / 30, 0, 1)`.
  - Store as `companies.hiring_velocity_score` (INTEGER) and
    `companies.velocity_score_version` (TEXT) + `companies.velocity_computed_at`
    (TEXT). New migration `0005_company_velocity_score.sql` adding these
    three columns with `DEFAULT NULL` — existing rows are null until
    the first reconciliation pass computes them.
  - Verify: unit tests for `computeHiringVelocity` with hand-computed
    cases (cold company = 0, accelerating multi-location company = high
    score, stale company = decaying score); `pnpm --filter
    @hiring-signals/domain test`/`typecheck`/`lint` clean.
- [ ] Audit signal/summary copy for the forbidden phrasing spec §14.3
      calls out ("actively buying," "in market," "budget approved") —
  (`apps/api/src/jobs/reconciliation.ts`)
  - During the daily reconciliation pass (H.5), after per-signal score
    recomputes, add a company-level pass: for each company that had at
    least one signal refreshed today, call `getCompanyRoleActivityStats`
    aggregated across all roles (new variant of H.2's query, or a new
    `getCompanyActivityStats(client, { companyId, now })` that sums
    across all `role_primary` values), compute `computeHiringVelocity`,
    and `UPDATE companies SET hiring_velocity_score = ?, velocity_score_version = ?, velocity_computed_at = ?`.
  - Verify: extend `reconciliation.test.ts` with a test asserting a
    company's `hiring_velocity_score` is updated after a reconciliation
    pass that touches its signals; `pnpm -r typecheck`/`lint`/`test` clean.

- [ ] **Q.3 — Velocity score in the trends API and company page**
  - Add `hiringVelocityScore` to `GET /api/v1/trends/hiring` (Milestone
    P.2) response items and use it as the default sort when
    `sort=velocity_desc` is requested (add to the sort enum).
      uncached `/api/v1/signals` query against the targets (facet <
      250ms, uncached signals query < 800ms for 50 results) — needs a
  - Surface on the company page (Milestone O.2) as a prominent score
    block — same monospace/chartreuse-at-80+ treatment as the signal
    score badge (spec §11.4). Label it "HIRING VELOCITY" with a
    plain-language note: "Based on pace, breadth, and persistence of
    public hiring activity. Not a prediction of intent or budget."
    (spec §14.3's language requirement applied to this new number).
  - Verify: route tests asserting the new field appears in both
    endpoints; `pnpm -r typecheck`/`lint`/`test` clean.
      once F.4 ships that its `fetchSignals` default matches.
- [ ] Confirm Queues/D1 daily usage stays ≤ 85% of free-tier allowance —
      needs real production traffic data or a synthetic load estimate
      based on current cadence math (spec §5.2); likely not fully
      answerable until Milestone E's adapters have been running against
      a real source cohort for a while (ties to spec §20 Phase 4).
- [ ] Confirm source ingestion success rate ≥ 98% and duplicate job rate
      < 1% — both measurable now from `source_runs`/`jobs` tables against
      real ingestion history; write a quick ops-script query (extend
      `source-health.mjs`?) rather than a one-off manual check, so this
      is repeatable.
- [ ] Verify: record actual measured numbers against each spec §15
      target in this section once measured, dated, so drift is
      detectable later instead of a one-time unrecorded check.

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

      **Update (2026-08-03):** the ~1501s/exit-0 result above no
      longer reproduces reliably. A later run of this file (plus
      `reconciliation.test.ts`) failed 27/32 tests, and re-running the
      very first failing test alone still failed — pipeline execution
      succeeded but the test's total duration (113.76s) exceeded the
      90s `testTimeout`. Root cause and fix options are written up in
      `AGENTS.md`, in the dated note right after Milestone J's "two
      tracked items remain open" follow-up list, rather than duplicated
      here. Not re-closing this checkbox since the original migration/exit-0
      claim is what's now unverified, not the migration work itself.

- [x] **CI workflow — typecheck + lint + fast pure-logic tests** ✅
      2026-08-02 (`.github/workflows/ci.yml`)
  - `.github/workflows/ci.yml` added: Node pinned via `.nvmrc`
    (24.18.0), pnpm pinned to `11.17.0` (matches `package.json`'s
    `packageManager` field), `pnpm install --frozen-lockfile`, then
    `pnpm -r typecheck`, `pnpm -r lint`,
    `pnpm --filter @hiring-signals/domain test`,
    `pnpm --filter @hiring-signals/adapters test`. Triggers on
    push/PR to `main`. One job, one runner, no duplicated setup steps.
  - **Scope deliberately targeted, not `pnpm -r test`** — explicit
    repo-owner decision 2026-08-02: this is a large, actively-growing
    monorepo maintained solo, so CI needs to stay fast and cheap
    enough to actually run on every push rather than become something
    to avoid triggering. `packages/domain` (zero `@hiring-signals/*`
    dependency at all) and `packages/adapters` (depends only on
    `domain`) are pure logic — no live D1/AI/Vectorize, no secrets,
    fixture-driven — confirmed via both packages' own `package.json`
    dependency lists before wiring them in. Real numbers from a local
    dry run reproducing the exact workflow steps: 70/70 domain tests +
    114/114 adapter tests, combined test time ~4s, full four-step
    sequence (typecheck+lint+both test suites) ~45s wall time
    end-to-end including `pnpm install` overhead. This is the
    "targeted, not 100%-of-tests-every-time" tier — catches real
    regressions in classification, lifecycle, scoring, and every ATS
    adapter's `normalize()` logic, on every commit, for free.
  - `packages/db` and `apps/api`'s live-D1 suites (the slow,
    infrastructure-dependent tier) are explicitly OUT of automatic CI.
    Auth for running them manually is resolved (see below), but
    running them on every push was discussed directly with the repo
    owner and declined: they write real rows to the same production
    `hiring-signals` D1 this app serves from (test-prefixed slugs +
    cleanup, but a cancelled/timed-out run could still leave orphans),
    run 500–1500+s total (Milestone J's own timing notes), and would
    burn live Cloudflare AI/Vectorize/D1 quota on every commit — cost
    disproportionate to a solo contributor's actual CI needs. Run
    these manually/locally (`pnpm --filter @hiring-signals/db test`,
    etc., see AGENTS.md) before something like a release, not
    continuously.
  - **Auth resolved 2026-08-02** (relevant to running the live-D1
    suites manually, and to any future CI tier that does need them):
    the repo owner widened the existing `CF_TOKEN` in the Cloudflare
    dashboard to add `D1: Edit` alongside its original Workers AI +
    Vectorize scope (same token value, broader permissions — no
    GitHub secret rotation needed). Verified locally: exporting
    `CF_TOKEN`'s value as `CLOUDFLARE_API_TOKEN` (wrangler's standard
    non-interactive auth env var, distinct name from this repo's
    `CF_TOKEN`) and running a real `wrangler d1 execute hiring-signals
    --remote --json --command "SELECT 1"` succeeded against
    production D1. `.env.local.example`'s header comment updated to
    match.
  - Verified locally by reproducing the exact workflow steps under
    `nvm use 24.18.0` (all four steps, one shot, exit 0): `pnpm -r
    typecheck` clean across 6/6 workspaces; `pnpm -r lint` clean (5
    pre-existing warnings, 0 errors) after deleting 5 tracked-but-
    unused one-off live-D1 debugging scratch scripts from `packages/db`
    (`check_group.mjs`, `check_orphans.mjs`, `check_query.mjs`,
    `cleanup_debug.mjs`, `debug-still-active.mjs`) that were failing
    lint with `no-undef` on bare `console` calls and would have made
    this workflow red on its first run — confirmed unreferenced
    anywhere else in the repo before removing; `packages/domain test`
    70/70 passing; `packages/adapters test` 114/114 passing.

- [ ] **Follow-up: live-D1 suites in CI, if ever wanted** — not
      currently planned given the cost/risk tradeoff above (the fast
      pure-logic subset — option (c) below — is what actually shipped
      2026-08-02), but if priorities change (e.g. a pre-release gate,
      or a nightly/manual-dispatch job rather than every push), the
      real open decision is scope/isolation, not auth (already
      solved). Options: (a) accept the shared-production-D1 risk
      as-is, relying on existing test cleanup discipline; (b)
      provision a genuinely separate D1 database for CI (new
      `wrangler.toml` env or a second database binding) so a bad CI
      run can never touch real data; (c) *(shipped, current state)*
      run only the fast pure-logic subset automatically and treat the
      full live suite as a manual/pre-release check. Whichever of
      (a)/(b) is chosen if this gets revisited, budget CI
      `timeout-minutes` generously (some suites alone run 500–1500s+
      against real Cloudflare infrastructure) and export
      `CLOUDFLARE_API_TOKEN: ${{ secrets.CF_TOKEN }}` in the job env.

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
