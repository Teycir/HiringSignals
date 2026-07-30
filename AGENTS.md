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
existing test file (`ingest-consumer.test.ts`, `scheduler.test.ts`,
`reconciliation.test.ts`, every `packages/db/test/*.test.ts`) still
uses today — those 163 tests are **not yet migrated**, tracked as its
own follow-up item (see ROADMAP.md's open-questions section), not
silently grandfathered in as an exception. Don't point to an existing
test file as precedent for a new fake; point to this section instead.

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

**Follow-up, tracked, not done today:** migrating the existing 163
tests off their in-memory fakes onto this policy is a real, separate
piece of work (touches nearly every test file in the repo, plus CI
secrets/workflow changes) — see ROADMAP.md.

---

## How to work in this repo

- Package manager: pnpm workspaces (`pnpm-workspace.yaml`). Never use npm/yarn.
- Typecheck a single workspace: `pnpm --filter @hiring-signals/<name> typecheck`
- Typecheck everything: `pnpm -r typecheck`
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
