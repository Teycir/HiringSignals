# AGENTS.md

Instructions for AI agents (Claude, opencode, etc.) working in this
repo. Read `hiring-signals-spec.md` first — that's the source of truth
for behavior. This file carries repo-wide policy and how-to-work notes;
it does not track implementation status itself — see `ROADMAP.md` for
that, kept in sync as work lands.

`ROADMAP.md` covers everything: Phase 0 and Phase 1 (both complete) plus
the write-path milestones (A onward — ingestion, adapters, scheduler,
UI, hardening/deploy). It's a task-by-task, spec-cited breakdown and the
single source of truth for status. Don't add a status checklist here;
add it to ROADMAP.md instead.

## Policy: fix and verify before advancing

**If you find a bug while working in this repo, fix it and verify the fix
before moving on to the next task.** Do not log it as a TODO and continue
to the original task as if it weren't there. "Verify" means actually
running the relevant command (typecheck, lint, or test) and reading its
output — not assuming it passes.

- A checkbox in `ROADMAP.md` is only checked once the code has been
  read and the fix verified — not because a prior session's summary
  claimed it, and not because the fix "looks right." Summaries drift from
  what's actually on disk; only the file contents and a command's exit
  code are ground truth.
- If a bug is found mid-task and it's small (a few files, no schema/API
  contract change), fix it immediately, in the same turn, before returning
  to what you were doing.
- If a bug is large (needs a migration, changes a public API contract,
  touches ingestion), it's fine to stop and fix it as its own next task —
  but it still gets fixed before unrelated new work starts, not deferred
  indefinitely as a TODO comment.
- Every fix gets typechecked (`pnpm --filter <workspace> typecheck`, or
  `pnpm -r typecheck` if the change could ripple across workspaces) before
  you say it's done. If a test exists for the touched code, run it too.
- When you fix something, write down _why_ it was wrong in the code
  comment or commit message, not just what changed — the next agent (or
  you, next session) needs the reasoning to avoid reintroducing it.

---

## Policy: zero mocks, zero fakes, zero synthetic in-memory stand-ins — tests run real code against real, live Cloudflare resources

**Superseded 2026-07-30: this repo's earlier convention (in-memory D1
fakes keyed on SQL substrings, `unusedBinding<T>()` Proxies for
AI/VECTORIZE, `vi.mock` swapping `createD1Client`) is retired, per an
explicit decision with the user.** That convention is what every
existing test file that touched Cloudflare bindings (`ingest-consumer.test.ts`,
`scheduler.test.ts`, `reconciliation.test.ts`, every `packages/db/test/*.test.ts`)
started with — **those files are now migrated (verified 2026-08-01,
all 7 test files passing against live `hiring-signals` Cloudflare
resources)**. Tests that never used synthetic Cloudflare stand-ins
(`packages/domain/test/*`: pure logic with fixture inputs;
`packages/adapters/test/*`: static JSON board-response fixtures with
real `normalize()`) were already compliant with this policy's intent
and required no migration. Don't point to an already-migrated test
file as precedent for writing a new synthetic stand-in; point to this
section instead.

**The rule, going forward, for any new or migrated test:** no mock of
this repo's own functions (already-established, still true) **and** no
in-memory/synthetic stand-in for `D1Database`, `Ai`, `VectorizeIndex`,
or any KV namespace either. A test must run the real code against the
real, live, deployed `hiring-signals` Cloudflare account resources —
the same D1 database, Vectorize index, and Workers AI binding
`infrastructure/scripts/` and `wrangler dev` already point at, not a
second/isolated test-only copy. This is a deliberate, accepted
trade-off, decided with the user along with everything below — not an
oversight to "fix" later:

- **Shared instance, not isolated.** Tests read/write the same D1
  database `seed-local-d1.sql` seeds and the ops scripts operate on —
  not a separate test database. A test run can and will mutate real
  dev data; there is no test-only sandbox.
- **Concurrency risk accepted, not mitigated.** Two test runs racing
  (parallel CI jobs, vitest's own file-level concurrency, a local run
  overlapping a CI run) can corrupt each other's data or produce
  flaky failures. Decided: accept this for now, revisit only if it
  causes real, observed problems — don't preemptively serialize CI or
  disable vitest concurrency as a defensive measure nobody asked for.
- **No scoped-down credential.** Tests authenticate with the same
  `CF_TOKEN`/credential the ops scripts already use (see
  `infrastructure/scripts/backfill-embeddings.mjs`'s `.env.local`
  convention) — not a narrower, test-only token. Decided: reuse what
  exists rather than provision a new scoped credential.
- **CI requires live network and credentials, unconditionally.**
  `pnpm -r test` (and its CI job) is no longer offline-safe — it needs
  `CF_TOKEN` and real network access to Cloudflare's APIs to pass at
  all. A CI environment without that credential configured will fail
  every test, by design, not as a bug.
- **Real, live D1 access from a plain test process still faces the
  same constraint `infrastructure/scripts/lib/d1-exec.mjs`'s own header
  documents**: there is no way to construct a live `D1Database` binding
  outside a Worker. Tests reach D1 the same way the ops scripts do —
  shelling out to `wrangler d1 execute --remote --json` (or an
  equivalent direct D1 HTTP API call) — not by importing
  `createD1Client` with a fabricated object. `AI`/`VECTORIZE` reach
  Cloudflare the same way `backfill-embeddings.mjs` does: direct REST
  calls (`api.cloudflare.com/.../ai/run/...`,
  `.../vectorize/v2/indexes/.../query`), not the Worker-only binding
  methods.
- Fixture *inputs* (a query string, a role filter, a company slug) are
  still fine to construct in a test — the rule is about not faking the
  systems that store/serve data, not about banning literal string
  constants in test code.
- **Two decided, documented exceptions (2026-07-30), narrower than the
  rule above suggests — both apply only to `apps/api/test/jobs/*.test.ts`,
  neither weakens the D1/AI/Vectorize/KV rule itself:**
  - **ATS adapter mocking (`vi.mock("@hiring-signals/adapters")` in
    `ingest-consumer.test.ts`).** Accepted, not a violation. This mocks
    `getAdapterForProvider` so `fetchBoard`/`normalize` return scripted
    values (a canned job payload, or a scripted HTTP status like
    429/503/404) to `handleIngestMessage`. The distinction from a
    forbidden fake: `fetchBoard` calls a real third-party ATS board over
    HTTP (Greenhouse, Lever, etc.) — there is no Cloudflare account
    resource backing it the way there is for D1/AI/Vectorize/KV, and no
    way to make a real board return 429/503/404 on demand for a test.
    What `ingest-consumer.test.ts` actually needs to verify is
    orchestration (retry/backoff/idempotency given an HTTP outcome), not
    "is a real board shaped the way we expect" — that question is
    already covered, with zero mocking, by `packages/adapters/test/*
    .test.ts`'s static JSON fixtures (`greenhouse.test.ts` et al., which
    call `normalize()` directly against real recorded board-response
    shapes). A scripted `fetchBoard` return value here is the same kind
    of fixture input the rule above already permits ("a query string, a
    role filter"), just shaped like an HTTP outcome instead of a string.
  - **`INGEST_QUEUE` (`Bindings["INGEST_QUEUE"]`, the
    `hiring-signals-ingest` Cloudflare Queue).** Accepted as a
    documented, permanent exception to the zero-fake rule — capture
    `send()` calls into an in-memory array (`sent: []`, same pattern
    `scheduler.test.ts`/`ingest-consumer.test.ts` already use), never
    call the real binding. Reasoning: unlike D1/AI/Vectorize/KV, a real
    `queue.send()` isn't a read/write against a resource the test itself
    observes — it hands a message to the *same* queue the real deployed
    consumer is subscribed to, which would actually dequeue and process
    it (re-triggering `handleIngestMessage` from inside a test of
    `handleIngestMessage`, or causing `scheduler.test.ts` to trigger real
    fetches against real ATS boards). No wrangler command exists to send
    without delivering (`wrangler queues pause-delivery` is
    account/queue-global, not per-test-run scoped, and would stall the
    real production cron pipeline while tests run — confirmed via
    `wrangler queues --help`, 2026-07-30). A second, test-only queue was
    considered and rejected: it would resolve the delivery problem but
    directly contradicts this policy's own "shared instance, not
    isolated" principle for every other resource, trading one
    inconsistency for another. Capturing sends in-memory is therefore
    the accepted trade-off, not a gap to close later.

**Follow-up items (core migration complete 2026-08-01):** all 7 test
files that previously used in-memory Cloudflare stand-ins (4
`packages/db/test/*.test.ts` + `reconciliation.test.ts` /
`scheduler.test.ts` / `ingest-consumer.test.ts` in `apps/api/test/jobs/`)
now run against live `hiring-signals` Cloudflare resources, with exit
code 0 and the two documented permanent exceptions above (ATS adapter
mock + INGEST_QUEUE in-memory capture). Two tracked items remain open,
neither blocking use of the migrated suite:

- CI workflow (`.github/workflows/` directory exists but contains no
  `*.yml`/`*.yaml` files as of 2026-08-01): add `CF_TOKEN` as a
  GitHub Actions secret and confirm `pnpm -r test` passes with
  live network access.
- `packages/test-support` follow-ups: dotenv parsing in
  `live-cf-bindings.ts` `loadCfToken()`, factoring duplicated
  `execRemote`/`runWrangler` spawn plumbing, credential preflight
  alignment, SQL redaction in thrown errors, and a short README /
  package doc comment explaining each live client's requirements.

See ROADMAP.md Milestone J for the full list with per-item detail.

---

## Policy: record session memory via butler MCP before ending a session

**Before ending any working session in this repo, record what happened
via the `butler` MCP server (`project_id: "HiringSignals"` — confirmed
registered in butler's project list as of 2026-08-01, ADR-001), not just
in chat.** Chat history is not durable across sessions the way butler's
project memory is — the next session (this agent or another) starts
cold unless the prior session wrote something down.

- **What to record, and with which tool:**
  - `butler:memorystore` (`type: "summary"`) — what was done this
    session: files touched, what changed and why, what was verified
    (typecheck/test command + exit code, not just "looks right" per the
    fix-and-verify policy above).
  - `butler:decisionrecord` — any real design/architecture decision made
    (a new pattern adopted, a trade-off accepted, a policy change like
    this one) — give it a `decision_id` (e.g. `ADR-00N`) so it's
    referenceable later, the same way this file already references
    `roadmapfix.md`-style tags in code comments.
  - `butler:memorystore` (`type: "rule"`) — a durable constraint or
    convention discovered this session that should bind future sessions
    (e.g. "X must always be Y because Z") — the kind of thing that would
    otherwise only live in one code comment or one person's head.
  - `butler:memorystore` (`type: "wiki"`) — reference material worth
    keeping around (a schema note, an external API's quirks) that isn't
    a one-off summary or decision.
- **Session lifecycle:** call `butler:sessionheartbeat` periodically
  during a long-running session (per its own description, ~every 15s
  while active), and call `butler:sessiondisconnect` when the session is
  actually ending — it flushes a handoff log, so it's the real "close
  out" step, not `memorystore` alone.
- This is in addition to, not instead of, updating `ROADMAP.md` and
  in-code comments. `ROADMAP.md`/code comments are what's true about the
  *codebase*; butler memory is what's true about *how the work
  happened* (reasoning, decisions, dead ends) — keep both current.
- Skipping this at the end of a session is the same class of problem as
  skipping verification before advancing (see "fix and verify before
  advancing" above): a future session inherits a false sense of context
  either way.

---

## How to work in this repo

- Package manager: pnpm workspaces (`pnpm-workspace.yaml`). Never use npm/yarn.
- Typecheck a single workspace: `pnpm --filter @hiring-signals/<name> typecheck`
- Typecheck everything: `pnpm -r typecheck`
- **Scope test runs to the file(s) you actually touched.** Every test
  that hits D1/AI/Vectorize (see "zero mocks, zero fakes" above) shells
  out to a live `wrangler`/Cloudflare REST call per seed/assert step,
  ~3.7s each -- a single file can legitimately take several minutes,
  and `pnpm -r test` / `pnpm --filter <pkg> test` with no path runs
  every live test in that scope, easily 10-15+ minutes. Run
  `npx vitest run <path/to/file.test.ts>` (from inside the workspace
  package directory, e.g. `cd packages/db && npx vitest run
  test/jobs-repo.test.ts`) while iterating on one file --
  `pnpm --filter <pkg> test -- <pattern>` does NOT reliably scope to a
  pattern in this setup (confirmed 2026-08-01: it ran the full
  workspace suite anyway) and its "whole suite" runtime should not be
  the default cost of verifying a single new/changed test file. Only
  run the full unscoped suite (`pnpm -r test` or a filter with no
  path) as a final check before considering a milestone done, not as
  the everyday inner-loop command.
- If a test times out at the 90s per-test default (`vitest.config.ts`
  in each workspace), the fix is almost always to seed fewer samples
  per test or cut unnecessary seeding calls (e.g. skip
  `recordSourceRunComplete` if the function under test never reads
  `completed_at`/`status`) -- not to raise the timeout. Match
  `company-role-stats-repo.test.ts`'s budget (its heaviest test uses 4
  seed calls, no override) rather than reaching for a per-test timeout
  override.

- `tsconfig.base.json` has `noUncheckedIndexedAccess` on — array/tuple
  destructuring and indexed access are `T | undefined`. Handle it with a
  real fallback (`?? []`, a guard, etc.), not a non-null assertion.
- Repository (SQL) code lives only in `packages/db`. Routes in `apps/api`
  never touch `D1Database` directly — always through `createD1Client`.
- Every SQL query is parameterized via `.bind()`. Never interpolate values
  into SQL text (see `packages/db/src/d1-client.ts` header comment).
- `packages/db` must stay framework-agnostic — no `hono` (or other
  apps/api-only) imports. If a repo function needs to signal a
  client-caused error (bad input, not a server fault), throw a plain
  `Error` subclass exported from the package (see `InvalidCursorError` in
  `signals-repo.ts`). Callers map it to whatever's appropriate for their
  context — an HTTP route in `apps/api` maps it to a status code (e.g.
  `InvalidCursorError` → 400), but not every typed error has an HTTP
  route above it: `DuplicateSourceError` (`sources-repo.ts`) is caught by
  the local ops source-management script (spec §13.5), not a route,
  since there is no `/api/v1/admin/*` surface — the app has no login and
  is public/free, permanently (spec §3, §14.1).
