# AGENTS.md

Instructions and living roadmap for AI agents (Claude, opencode, etc.)
working in this repo. Read `hiring-signals-spec.md` first — that's the
source of truth for behavior. This file tracks _implementation status_
against the spec, kept in sync as work lands, and gives agents entry
points so they don't have to rediscover context each session.

For anything past Phase 1's read-path (i.e. write paths, ingestion,
adapters, scheduler, UI, hardening/deploy), see **`ROADMAP.md`** — a
task-by-task, spec-cited breakdown. This file (AGENTS.md) keeps the
short status view per phase; `ROADMAP.md` is where a phase gets planned
out into ordered, independently-verifiable tasks before implementation
starts.

## Policy: fix and verify before advancing

**If you find a bug while working in this repo, fix it and verify the fix
before moving on to the next task.** Do not log it as a TODO and continue
to the original task as if it weren't there. "Verify" means actually
running the relevant command (typecheck, lint, or test) and reading its
output — not assuming it passes.

- A checkbox in the roadmap below is only checked once the code has been
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
