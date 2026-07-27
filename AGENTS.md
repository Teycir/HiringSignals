# AGENTS.md

Instructions and living roadmap for AI agents (Claude, opencode, etc.)
working in this repo. Read `hiring-signals-spec.md` first — that's the
source of truth for behavior. This file tracks _implementation status_
against the spec, kept in sync as work lands, and gives agents entry
points so they don't have to rediscover context each session.

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
  `signals-repo.ts`) and let the route layer in `apps/api` catch it and
  map it to the right HTTP status.
- A signal can have multiple `signal_evidence` rows pointing at different
  `jobs`. Filtering signals by a job-level column (location_mode,
  country_code, source provider) must use `EXISTS (...)`, never a plain
  `JOIN`, or matching signals get duplicated once per matching evidence row.

---

## Roadmap

### Phase 0 — Scaffolding

- [x] pnpm workspace, strict TS base config, Prettier, shared ESLint base
- [x] `apps/web`: Next.js 16 + Tailwind + TS scaffold, `lib/api-client.ts`
      wired to call the Worker API only (never ATS providers directly,
      spec 12.1)
- [x] `apps/api`: Hono Worker with request-id/security-headers/error-handler
      middleware chain, `wrangler.toml` with D1/KV/Queues bindings,
      15-minute scheduler cron config (spec 13.1)
- [x] `packages/domain`: role taxonomy, ATS provider enum, NormalizedJob/
      Signal/IngestMessage Zod schemas, API envelope helpers
- [x] Migration applied against a real D1 database — `hiring-signals` D1
      database, `CACHE` KV namespace, and `hiring-signals-ingest` queue are
      all provisioned; `wrangler.toml` has real resource IDs, not
      placeholders. R2 was dropped from the design entirely (raw payload
      archive + export artifacts now live in KV under TTL-based keys) so
      the project doesn't require Cloudflare billing/a credit card.
- [ ] Seed fixtures to test read paths against real data
- [x] Anti-abuse middleware: `apps/api/src/middleware/anti-abuse.ts`
      (`freeReadTier()` / `protectedWriteTier()`) wrapping
      `lib/http/rate-limit.ts` (KV sliding-window: 600 req/300s read tier,
      30 req/300s write tier), `lib/http/turnstile.ts` (Cloudflare Turnstile
      CAPTCHA, gracefully downgrades to rate-limit-only if
      `TURNSTILE_SECRET_KEY` is unset), and `lib/observability/audit-abuse.ts`
      (fire-and-forget abuse-event logging to KV). Global `clientIp()`
      middleware in `apps/api/src/middleware/client-ip.ts` sets
      `Variables.clientIp` (CF-Connecting-IP → X-Forwarded-For → "unknown")
      and a default `abuseVerdict` on every request before route-level
      anti-abuse middleware runs. Wired onto `GET /signals`, `/companies`,
      `/facets`, `/health` (free tier) and `POST /admin/sources`,
      `PATCH /admin/sources/:id`, `POST /admin/ingestion/run` (protected
      tier, replacing the old prod-only 401 placeholder). Verified:
      `pnpm -r typecheck` clean.
  - **Note — this is not the Auth item below.** Rate-limit + CAPTCHA stops
    high-volume/automated abuse; it does not check *who* is calling. Any
    caller that solves the CAPTCHA and stays under 30 req/300s can still
    hit the admin write routes in production. The "Auth (blocking for any
    production deploy)" section further down is still unimplemented and
    still blocks prod deploy independently of this item.
  - [x] **Fixed — `lib/http/circuit-breaker.ts` is now wired in, no longer
    dead code.** Previously both its own file header and the
    `apps/api/tsconfig.json` comment claimed it was used by
    `anti-abuse.ts` + "repo wrappers," but a full-tree grep found zero
    imports anywhere. Every repo function goes through exactly one choke
    point — `createD1Client(c.env.DB)`, called fresh per-request in each
    route (`apps/api/src/routes/{signals,companies,facets}.ts`) — so
    `withCircuit("db", ...)` is now applied inside `lib/d1/client.ts`
    itself, wrapping `first`/`all`/`run`/`batch`. This protects every repo
    call with zero call-site changes, instead of threading `withCircuit`
    through each `*-repo.ts` function individually. Module-level breaker
    state is safe here for the same reason `circuit-breaker.ts`'s own
    header comment gives: a Worker isolate handles one request at a time.
    `packages/db/tsconfig.json`'s include glob now also lists
    `lib/http/circuit-breaker.ts` (needed since `lib/d1/client.ts` imports
    it and `packages/db` must typecheck standalone). Verified:
    `pnpm -r typecheck` and `pnpm -r lint` both clean across all 5
    workspace projects; adapter test suite (17 tests, unaffected by this
    change) still green.
  - **Also fixed while verifying the above — stray `__sqlite_probe.ts`
    broke local `packages/db` typecheck.** `packages/db/src/` had an
    untracked, gitignored scratch file (`import { DatabaseSync } from
    "node:sqlite"`) matched by `src/**/*.ts` in `packages/db/tsconfig.json`.
    It's invisible to `git status`/`git diff` (matched by `.gitignore:39`,
    `__*.ts`) but still sat on disk and made `pnpm --filter
    @hiring-signals/db typecheck` fail locally with
    `Cannot find module 'node:sqlite'` — meaning the "Known-good
    verification commands" below couldn't be trusted to actually pass for
    any dev who'd ever run that probe. Deleted it (disposable scratch
    output, not referenced by any real module). If you need to probe
    `node:sqlite` again locally, do it outside `packages/db/src/` — that
    whole directory is typechecked as real source.

### Phase 1 — D1 schema + read paths

- [x] `infrastructure/d1/migrations/0001_initial_schema.sql`: full schema
      from spec 8.2 — companies, sources, source_runs, jobs,
      job_observations, signals, signal_evidence + 3 feed/lookup indexes
- [x] `packages/db/src/d1-client.ts`: parameterized D1 client wrapper
      (spec 14.1) — `first`/`all`/`run`/`batch`, all through `.bind()`
- [x] `packages/db/src/signals-repo.ts`: cursor-paginated signal feed
      (`score_desc`/`newest`/`company_asc`), signal detail + evidence
- [x] `packages/db/src/companies-repo.ts`: company autocomplete, detail,
      recent signals
- [x] `packages/db/src/facets-repo.ts`: KV-cached facet counts (roles,
      sources, locationModes) via `client.batch`
- [x] `apps/api` routes wired to real D1 queries (no longer stubs):
      `GET /api/v1/signals`, `/signals/:id`, `/companies`,
      `/companies/:slug`, `/facets`
- [x] Workspace-wide typecheck clean (`pnpm -r typecheck`) — verified after
      the `noUncheckedIndexedAccess` fix in `facets-repo.ts` (`?? []`
      fallback on the destructured `client.batch` tuple, not a suppression)
- [x] **Fixed — cursor pagination now respects `sort`.** Previously
      `encodeCursor`/`decodeCursor` only encoded
      `score:lastDetectedAt:id` and the WHERE clause always compared on
      those three columns regardless of which `orderBy` was actually
      active — correct for `sort=score_desc` but silently wrong (dup/
      skipped rows) for `sort=newest` and `sort=company_asc`. Fixed by
      encoding `{sort, score, lastDetectedAt, companyDisplayName, id}` as
      base64 JSON (not a manually joined/split string — company names can
      contain the delimiter) and branching the WHERE comparison per sort
      in `listSignals`. A cursor issued for one sort and replayed against
      a different `sort` now throws `InvalidCursorError`, which
      `apps/api/src/routes/signals.ts` catches and maps to
      `400 REQUEST_ERROR` (previously would have fallen through to a
      generic `500`). Verified: `pnpm -r typecheck` clean.
- [x] **Fixed — `locationMode`/`country` filters now apply.** Were
      accepted by the route schema and `ListSignalsParams` but the
      `listSignals` branch was an empty no-op. Fixed with an `EXISTS`
      subquery through `signal_evidence` → `jobs` (`j.location_mode` /
      `j.country_code`) — `EXISTS`, not `JOIN`, so signals with multiple
      evidence rows aren't duplicated in results. Verified:
      `pnpm -r typecheck` clean.
- [x] **Fixed — `source` filter was silently unused (found while fixing
      the above).** `ListSignalsParams.source` was accepted from the route
      and typed, but never referenced anywhere in `listSignals`'s WHERE
      construction — a second no-op alongside `locationMode`, just without
      even a comment flagging it. Fixed with the same `EXISTS` pattern,
      joining `signal_evidence` → `jobs` → `sources` on `src.provider`.
      Verified: `pnpm -r typecheck` clean.
- [ ] No test coverage yet for `listSignals`'s cursor/sort or
      locationMode/country/source filtering — the fixes above are
      typecheck-clean but not exercised against real data (blocked on the
      Phase 0 seed-fixtures item). Add `packages/db` vitest cases once
      seed data exists, particularly: paging through `sort=newest` and
      `sort=company_asc` across a page boundary, and a signal with
      evidence pointing at jobs in two different `location_mode`s to
      confirm no duplicate rows from the `EXISTS` filters.
- [x] **Fixed — workspace lint was completely broken, not just missing
      for `packages/db`.** The roadmap previously understated this as "no
      eslint config for packages/db." Actual scope, confirmed by running
      `pnpm -r lint`: it hard-failed with exit 1 on the _first_ package in
      run order (`packages/domain`, `spawn ENOENT: eslint`) — meaning it
      never even reached `packages/db`, `packages/adapters`, or
      `apps/api` to check them. Root cause: `eslint.base.mjs` (repo root)
      imports `@eslint/js` and `typescript-eslint` directly, but neither
      the root `package.json` nor any package besides `apps/web` (which
      uses `eslint-config-next` instead and never touches the shared base)
      declared `eslint`, `@eslint/js`, or `typescript-eslint` as
      dependencies anywhere resolvable. Fixed by: adding `eslint`,
      `@eslint/js`, `typescript-eslint` as root devDependencies (Node ESM
      resolves `eslint.base.mjs`'s bare imports relative to the root,
      where the file itself lives — installing them only inside a
      package's own `node_modules` does not help), adding `eslint` itself
      to each of `packages/domain`, `packages/adapters`, `packages/db`,
      `apps/api` so their own `eslint` binaries resolve, and adding a
      3-line `eslint.config.mjs` to each importing `../../eslint.base.mjs`
      unchanged (no package-specific overrides needed — none of these
      four have a framework layer requiring one). Verified:
      `pnpm -r lint` now runs to completion across all 5 workspace
      projects with exit code 0 (one pre-existing `no-console` warning in
      `ingest-consumer.ts`'s stub, not an error, not new); `pnpm -r
    typecheck` re-verified clean after the dependency changes too.

### Phase 1 — Write paths / ingestion (not started)

- [ ] `sources` / `jobs` write-path repos in `packages/db` (upserts,
      `job_observations` inserts, lifecycle transitions per spec 5.4)
- [ ] `packages/adapters`: per-provider `AtsAdapter` implementations
      (greenhouse, lever, ashby, smartrecruiters, workable, recruitee,
      personio, teamtailor, jazzhr, breezy, bamboohr — see
      `admin.ts::addSourceSchema` for the full provider enum). Only the
      adapter _interface_ exists so far (spec 5.3).
- [ ] `apps/api/src/jobs/scheduler.ts`: currently an empty stub
      (`TODO(Phase 1)`). Needs to query D1 for due sources
      (`enabled=1 AND next_poll_at <= now()`) and enqueue one
      `IngestMessage` per source with deterministic jitter (spec 5.2).
      Must never fetch a provider directly — only enqueue.
- [ ] `apps/api/src/jobs/ingest-consumer.ts`: currently a stub that just
      logs and acks (`console.log("ingest_stub", ...)`). Needs to wire
      fetch → validate (adapter Zod schema) → normalize → upsert jobs →
      insert observations → compute lifecycle/signal transitions → write
      source_run metrics (spec 5.1/13.3). Must be idempotent per
      `(sourceId, runId)`.
- [ ] `apps/api/src/routes/admin.ts`: all four routes (`POST /sources`,
      `PATCH /sources/:id`, `POST /ingestion/run`, `GET /health`) are
      request-validated but return stub/placeholder responses — no D1
      writes yet.

### Auth (blocking for any production deploy)

- [ ] `apps/api/src/routes/admin.ts` only soft-gates on
      `ENVIRONMENT !== "production"` (throws 401 if `production`, allows
      everything otherwise — including in staging/preview). Cloudflare
      Access / role-based auth per spec 14.1 is not implemented.
      **Do not deploy to production as-is.**

### Phase 2 — UI (not started)

- [ ] Brutalist design tokens / dashboard UI per spec design philosophy
      (strict black/white, dense information, hard edges)

---

## Known-good verification commands

Run these before claiming any roadmap item done:

```bash
pnpm -r typecheck   # whole workspace
pnpm -r lint        # whole workspace, all 5 projects (fixed — see Phase 1 entry above)
pnpm --filter @hiring-signals/api typecheck
pnpm --filter @hiring-signals/db typecheck
```

## File map for common tasks

| Task                            | File(s)                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| Add/change a D1 query           | `packages/db/src/*-repo.ts`                                                |
| Change API contract for a route | `apps/api/src/routes/*.ts` (Zod schema at top of file)                     |
| D1 schema change                | `infrastructure/d1/migrations/000N_*.sql` (new migration, never edit 0001) |
| Add an ATS provider adapter     | `packages/adapters/` (interface only today)                                |
| Ingestion/cron logic            | `apps/api/src/jobs/{scheduler,ingest-consumer}.ts`                         |
| Shared types/enums              | `packages/domain/`                                                         |
