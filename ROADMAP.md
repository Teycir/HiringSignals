# ROADMAP.md

Detailed, sequenced task breakdown for work remaining on HiringSignals.
`AGENTS.md` keeps the short status view and repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable
tasks before anyone starts writing code, so scope doesn't get
discovered mid-implementation.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task below cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

**Completed milestones removed from this file (2026-08-07) to keep it
current-work-focused:** Phase 0 (scaffolding), Phase 1 (D1 schema +
read paths), Milestone A (write-path repos), B (classification/
lifecycle), C (signal generation), D (scheduler/queue/ops scripts), E
(8 ATS adapters), F (dashboard UI — built, then deleted 2026-08-07 in
favor of the CLI), G.1–G.2 (security audit + gap closure), H
(signal-quality logic pass), I (semantic search, I.1–I.5), J (live-D1
test migration), K (`still_active` signal + latency metric), L (CSV
export), M (bulk CSV import). Full history for all of these remains in
git (`git log -- ROADMAP.md`) and in `CHANGELOG.md`. Nothing below
describes work that's already shipped.

---

## How to use this file

- Work top to bottom within a milestone; milestones themselves are
  ordered by hard dependency.
- A task is only checked off once code is written, the cited spec section
  re-read against what was built, and the listed verification command run
  with a real passing result — same bar as AGENTS.md's "fix and verify"
  policy.
- If a task turns out bigger than it looks once you're in the code, stop
  and split it into sub-tasks here rather than quietly expanding scope
  inside one commit.
- Update `CHANGELOG.md` when a milestone completes.

---

## Milestone F.1 — CLI (`apps/cli`), primary interface — complete, landed 2026-08-07

**Complete.** All six subtasks below shipped 2026-08-07. `apps/cli` is
the primary interface — the API (`apps/api`) remains reachable directly
via HTTP too, but `hs` is the intended entry point for an agent. See
`apps/cli/README.md` for exact command invocations and output.

**Why this exists (decided with the user 2026-08-07):** the real
end-user of this tool is an AI agent acting on a person's behalf — the
person asks their assistant to look something up, and the assistant
invokes the CLI — not a human typing commands or clicking through a
browser directly. That reverses the usual CLI design priorities: no
interactive prompts (an agent can't respond to a stdin prompt), no
progress spinners or ANSI color as the primary output channel, no
"friendly" reformatting that varies between runs. The dashboard
(Milestone F) was deleted, not kept, so this CLI is now the only
planned path to a working interface.

**Design principles, all in service of agentic (not human-interactive)
use:**

1. **Structured output by default, not opt-in.** Every command emits
   JSON on stdout by default (`--format table` available for a human
   who's debugging by hand, but never the default). One JSON object or
   array per invocation — no multi-line human-readable banners mixed
   into stdout that a JSON parser would choke on.
2. **Machine-readable errors.** Failures print a single JSON object to
   stderr (`{"error": {"code": ..., "message": ..., "requestId": ...}}`)
   and set a non-zero exit code. No stack traces on stdout, no
   "Oops, something went wrong! 🙁" — an agent parsing this needs the
   `code` field to branch on, the same way apps/api's routes already
   return typed error codes today.
3. **No interactive prompts, ever.** Every input is a flag or
   positional argument. A command that would need confirmation (e.g. an
   admin action) takes an explicit `--yes`/`--confirm` flag instead of
   pausing for a y/n keypress — an agent has no terminal to type into.
4. **Deterministic, scriptable, idempotent where the underlying API is.**
   Same input flags → same shape of output, run after run. Exit codes
   follow standard convention (0 success, non-zero failure) so an agent
   can branch on `$?` without parsing prose.
5. **Thin client over `apps/api`, not a new backend.** The CLI calls the
   same Cloudflare Worker routes the dashboard already used (`GET
   /signals`, `/signals/:id`, `/companies`, `/companies/:slug`,
   `/export/signals.csv`, `/facets`, `/sources`, and the `POST
   /admin/*` routes) — decided with the user 2026-08-07. No direct D1
   access, no bypassing the API's validation/rate-limiting/auth. This
   keeps exactly one source of truth for business logic instead of
   duplicating it into the CLI.

**Target command surface (mirrors existing routes 1:1 — no new backend
behavior invented here):**

**Reference, not a live dependency:** `apps/web`'s `lib/api-client.ts`
(deleted 2026-08-07 with the rest of `apps/web`) is still visible in
git history at commit `e102eeb` and is worth reading before starting
F.1.1, not copying from. Its shape is the right starting point: a
typed `request<T>()` wrapper, a per-route typed function per endpoint
(`fetchSignals`, `fetchSignalDetail`, ...), and an `ApiClientError`
class carrying `code`/`message`/`requestId`. One real finding from
reading it: it hand-rolled its own inline `apiErrorSchema` Zod schema,
duplicating the shape `packages/domain/src/api-envelope.ts` already
exports as `apiErrorSchema` — apps/web's own version was itself
something that should have imported the domain package's schema, not a
pattern to repeat. The CLI's HTTP client should import `apiErrorSchema`
from `@hiring-signals/domain` directly rather than redefine it a third
time.

**Resolved (F.1.1):** `signalsQuerySchema` moved to
`packages/domain/src/signals-query.ts`; `apps/api/src/routes/signals.ts`
re-exports it rather than defining its own, and `apps/cli` imports the
same symbol — see that file's own header comment for the full
reasoning. The route and the CLI now provably validate against one
schema.

- [x] **F.1.1 — CLI scaffold (`apps/cli`)**: new workspace package.
  Argument parsing: **citty** (chosen). Shared HTTP client
  (`apps/cli/src/api-client.ts`) importing `apiErrorSchema` from
  `@hiring-signals/domain`. `HS_ADMIN_SECRET`/`HS_API_BASE_URL` env
  vars, never an interactive login flow. `signalsQuerySchema`
  export-location decision resolved (see above).
  **Scope note, undocumented until now:** the `--format json|table`
  global flag described above was never implemented — every command
  hardcodes JSON-only output (no `--format` flag exists anywhere in
  `apps/cli/src`). JSON-by-default (principle 1) is intact and is the
  part that actually matters for the agent use case; the human-facing
  `table` fallback was silently dropped at some point in F.1.1-F.1.4
  and isn't tracked as a follow-up here yet — add a subtask if a human
  debugging by hand turns out to need it.
- [x] **F.1.2 — Read commands**: `hs signals list [--role --company --q
  --location-mode --country --source --signal-type --min-score
  --observed-since --cursor]`, `hs signals get <signalId>`, `hs
  companies list [--filters]`, `hs companies get <slug>`, `hs facets`,
  `hs sources list`. Each maps directly to its existing `GET` route and
  passes the same query parameters through unchanged.
- [x] **F.1.3 — Export command**: `hs export signals [--same filters as
  signals list] [--out <path>]` — streams the existing CSV export route
  to a file or stdout.
- [x] **F.1.4 — Admin commands**: `hs admin source run <sourceId>
  --yes`, `hs admin scheduler flush --yes`, `hs admin reconcile --yes`
  — thin wrappers over the existing `POST /admin/*` routes, each
  requiring the explicit `--yes` flag per principle 3 above.
- [x] **F.1.5 — Tests**: `apps/cli/test/api-client.test.ts` (mocked
  `fetch`, 14 tests: success/error envelopes, network failure, invalid
  JSON, query serialization, admin-secret gating) and
  `apps/cli/test/cli-process.test.ts` (5 tests, real `bin/hs.mjs`
  subprocess spawns asserting exit code and single-JSON-object
  stderr-shape). 19/19 passing.
- [x] **F.1.6 — Docs**: `apps/cli/README.md` with one example invocation
  and its exact JSON output per command, written for an agent's context
  window (short, literal, no marketing prose) rather than a human
  tutorial.

**Dependencies:** None blocking. `apps/api` is complete and stable —
every route F.1.2–F.1.4 wrap already exists, is tested, and is in
production use via direct HTTP today. F.1 can start immediately;
nothing else in this roadmap needs to land first.

**What depends on F.1:** Milestone N (saved filters) is explicitly
sequenced after F.1.1 (needs the CLI scaffold and its config-file
convention to exist first). Milestone P.3 (trends surface) is
sequenced after F.1 + O.2. No other milestone blocks on this one —
`apps/api`'s routes remain directly callable over HTTP in the meantime,
so F.1 is additive (a better interface) rather than a prerequisite for
anything else to function.

**Milestone-level acceptance criteria (all six subtasks done, plus) — all satisfied 2026-08-07:**
- [x] Every command in F.1.2–F.1.4's target surface implemented and
  callable against a real local `apps/api` (`wrangler dev`), not just
  against F.1.5's mocks. Manually verified: `facets`, `signals
  list/get`, `companies list/get`, `sources list`, `export signals`
  (with and without `--out`), `admin source run/scheduler
  flush/reconcile`.
- [x] `pnpm --filter @hiring-signals/cli typecheck`/`lint`/`test` clean,
  and workspace-wide `pnpm -r typecheck`/`lint` still clean afterward
  (6 of 7 workspace projects — `packages/ui` remains unscaffolded,
  unrelated to F.1).
- [x] Manual smoke test: `hs signals list --role backend` (note: singular
  `--role`, not `--roles`) confirmed to print exactly one parseable
  JSON error object to stderr on validation failure, and exactly one
  JSON object to stdout on success, nothing else mixed in on either
  stream — verified directly and via `cli-process.test.ts`'s
  single-stderr-line assertion.
- [x] `README.md`'s Layout table and `llm.txt`'s Architecture/Status
  sections updated from "planned, not started" to "complete."

---

## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §11.1 (security controls, audited/closed — see removed-milestones
note above for G.1/G.2), §12 (performance/reliability targets), §15
(CI/CD), §16 (acceptance criteria). G.1/G.2 are done and removed from
this file; G.3–G.5 below are the open remainder.

### G.3 — Performance targets verification (spec §12)

Mostly verification against already-built infrastructure (facet KV
cache, cursor pagination, indexed queries) rather than new work.
Attempted 2026-08-05: production D1 currently has only 6 `jobs` rows
and 7 `source_runs` (both from 2 test-fixture sources, `acme-corp`/
`globo-labs`, now `enabled=0`) — too little real traffic for a
meaningful p95/quota measurement, so items below split into what's
verifiable now vs. blocked on real source volume.

**2026-08-08 cleanup:** a separate, unrelated set of test-fixture rows
(5 `companies` rows named "Reconciliation Fresh/Raced/Stale Co", slugs
`test-recon-*`, created 2026-08-07 by `reconciliation.test.ts`'s live-D1
runs) was found sitting in production alongside the `acme-corp`/
`globo-labs` fixtures referenced above. Verified zero dependent `sources`/
`jobs` rows, then deleted (`DELETE FROM companies WHERE id IN (...)`,
5 rows removed, confirmed via follow-up `SELECT`). `acme-corp`/`globo-labs`
were deliberately left in place — they have 6 real dependent `jobs` rows
and 7 `source_runs` this section's own numbers cite as a baseline, so
removing them would need a real cascade decision, not a same-day cleanup.

- [ ] Measure actual p95 latency for cached facet response and
      uncached `/api/v1/signals` (targets: facet < 250ms, uncached
      signals query < 800ms for 50 results) — still blocked on a
      realistic row count; the 6-row production table and 20-company
      local fixture are both too small to produce a meaningful number.
      Decide seed-data vs. synthetic-dataset tradeoff before attempting.
- [x] **Confirm default API page size stays ≤ 50 signal rows** —
      ✅ done 2026-08-05. `apps/api/src/routes/signals.ts`'s
      `limit: z.coerce.number().int().min(1).max(100).default(50)`
      enforces a 50 default and 100 hard cap on pagination, matching
      the ≤50-row target for spec §12's first-page budget.
- [ ] Confirm Queues/D1 daily usage stays ≤ 85% of free-tier allowance —
      still blocked: no enabled production source exists today (both
      registered sources are disabled test fixtures), so there's no
      real polling cadence to measure against the free-tier ceiling.
- [x] **Confirm source ingestion success rate ≥ 98% and duplicate job
      rate < 1%** — partially done 2026-08-05, tooling built, numbers
      not yet meaningful. New `infrastructure/scripts/
      ingestion-metrics.mjs` computes both from `source_runs`/`jobs`
      directly (`--remote`/`--local`, `--since` window, defaults to
      30 days). Run against production: 0% success (0/7) — both runs
      are the same 2 disabled test-fixture sources hitting real 404s,
      not a live-cohort failure rate; not comparable to the ≥98% target
      until a real source is enabled. Duplicate rate: hard duplicates
      are structurally 0% (`jobs.UNIQUE(source_id, external_job_id)`
      + `upsertJob`'s update-on-resight behavior); "likely duplicate"
      (title+location+company, spec §7) is 0% on the 6 rows that exist,
      but **found a real gap along the way**: spec §7's third
      likely-duplicate field, `requisitionId`, is parsed from adapter
      payloads into the domain model
      (`packages/domain/src/job.ts`) but never persisted — no `jobs`
      column, no migration, confirmed by reading the schema and every
      call site, not assumed. The script's duplicate check is title+
      location+company only and says so in its own output; closing the
      `requisitionId` gap is new scope, not part of this verification
      item, and isn't tracked as a separate task here since it's a
      minor, spec-flagged approximation rather than a functional bug.
- [ ] Verify: record actual measured numbers against each spec §12
      target, dated, so drift is detectable later — done for the
      "≤ 50 rows" target above; the rest wait on real source traffic.

### G.4 — CI/CD hardening (spec §15)

Spec §15 describes a 4-environment model (Local/Preview/Staging/
Production) and a 7-step deployment sequence. Current CI
(`.github/workflows/ci.yml`) covers typecheck/lint/fast-tests only.

- [x] **Decide realistic environment scope for a solo-maintainer
      project.** ✅ decided 2026-08-06 (repo owner): stays simplified,
      not the spec's 4-tier Local/Preview/Staging/Production model.
      Current shape — Local (`wrangler dev` + local D1) and Production
      (`hiring-signals`), plus the isolated `hiring-signals-ci` database
      Milestone J already provisioned for automated live-D1 tests — is
      the accepted end state, not an interim step toward the full
      4-tier model. No separate Preview/Staging D1 registries planned.
- [x] **Lint must be zero-error, zero-warning on every push.** ✅ done
      2026-08-06. Every workspace package's `lint` script now passes
      `eslint . --max-warnings 0`. Verified: `pnpm -r typecheck`/`lint`
      clean across all 6 workspace packages after the change.
- [ ] If any deploy automation is added: never point preview/staging at
      production secrets or write bindings (spec §15.1) — mostly moot
      now that G.4's environment-scope decision (above) rules out a
      separate preview/staging tier, but leaving this as an explicit
      guardrail rather than deleting it: if that decision is ever
      revisited, this constraint still applies.
- [x] **Rollback readiness (spec §15.3) — audited 2026-08-06, corrected
      same day after token scope was widened.** The Worker has been
      deployed 8 times, all on 2026-07-30, currently serving version
      `82df9ce2` at 100% traffic, confirmed live and responding
      correctly at `https://hiring-signals-api.teycircoder14.workers.dev`.
      That live version predates every commit from 2026-08-06
      (I.5c/I.5d, test-support fixes, lint enforcement), so production
      is currently running stale code — a real redeploy is needed,
      intentionally deferred until local ingestion is validated against
      real data sources first. Versioned-deployment history now
      confirmed to genuinely exist (8 real entries), so a rollback
      (`wrangler rollback` or `wrangler deploy` to a prior version) is
      mechanically available and testable once we're deploying again —
      not yet exercised.
- [x] **Feature-flag pattern for scoring formula changes (spec §15.3) —
      audited, partial gap found, 2026-08-06.** `packages/db`'s schema
      has no `velocity_score_version` column at all (Milestone Q, the
      feature that field would belong to, is unbuilt). `score_version`
      (spec §7.2's existing signal score) is real and does one of spec
      §15.3's two asks: every scored signal persists
      `SCORE_FORMULA_VERSION` (currently `"v2"`), so old and new-formula
      rows stay distinguishable after a change. **What's missing:** no
      runtime feature-flag toggle to run old-vs-new scoring side by
      side before defaulting to a new formula — `SCORE_FORMULA_VERSION`
      is a hardcoded module constant. Given the "stays simplified"
      environment-scope decision above and no second scoring-formula
      change in flight, building a real flag mechanism speculatively
      isn't justified today — recording the gap accurately rather than
      building unneeded infrastructure.

### G.5 — Acceptance criteria sign-off (spec §16)

Run this last, after G.1–G.4 and Milestone F.1 are both complete —
several §16 items are UI/interface-dependent and several are
backend-dependent. Don't attempt this checklist until both are done;
it's a joint sign-off, not a G-only task.

- [ ] Walk every checkbox in spec §16.1 (functional), §16.2 (visual/
      interaction), §16.3 (security/operations) and mark pass/fail with
      a one-line note on how it was verified (manual test, automated
      test, code audit).
- [ ] Any failing item gets its own follow-up task here rather than
      being silently marked "close enough."

---

## Milestone N — Saved filters (local config file, no backend) — complete, landed 2026-08-07

Spec §2.2 (P1: "Saved role/location filter profiles"). Deliberately
local-only — no backend, no accounts, no new API surface. Spec P1 says
"saved dashboard view," which assumed `apps/web`'s `localStorage`
mechanism at the time it was written; `apps/web` was deleted
2026-08-07, so this milestone has been rewritten against `apps/cli`
(Milestone F.1) instead. The `localStorage` mechanism doesn't port —
a CLI is a Node process with no browser storage API — but the
underlying value (don't re-type role/location every invocation) maps
cleanly onto a local config file, which is the CLI-native equivalent.

**Why this adds value:** passive job seeker re-enters role/location
preferences every invocation without this. Lowest-effort high-retention
feature available.

- [x] **N.1 — Filter profile save/load** (`apps/cli`) — done 2026-08-07.
  - New `apps/cli/src/config-store.ts`: `getConfigPath`,
    `loadSavedFilters`, `saveFilters`, `clearSavedFilters`,
    `hasAnyFilter`. Stores the **raw pre-parse flag strings** (e.g.
    `{ role: "cybersecurity" }`), not `signalsQuerySchema`'s
    parsed/defaulted output — storing the parsed output would have
    silently baked `sort`/`limit`/`minScore` defaults into every saved
    profile even for fields the user never touched. Path resolution:
    `~/.hiring-signals/config.json` primary,
    `$XDG_CONFIG_HOME/hiring-signals/config.json` when that env var is
    set (spec's own "or `$XDG_CONFIG_HOME` equivalent" wording, read
    literally as two distinct path shapes rather than one). `HS_CONFIG_DIR`
    is a CLI-internal test seam, not a public flag/env var.
  - `hs signals list --role backend --location london --save` writes
    the current filter flags under a `savedFilters` key — implemented
    exactly as specified (note: the real flag is `--location-mode`, not
    `--location`; the milestone's own example predates that naming).
  - `hs signals list` with **no** filter flags and a saved profile
    present: applies the saved profile automatically, printing
    `Using saved filters: role=..., ...` to stderr (stdout stays pure
    JSON) — verified live against a local `wrangler dev` instance, not
    just the mocked/unreachable-host test path.
  - `hs signals list --clear-saved` removes the saved profile, prints
    `{"data":{"clearedSaved":true}}`, no-ops (not an error) if nothing
    was saved.
  - No v1 versioning: invalid/corrupt saved JSON is silently discarded
    on load via `signalsQuerySchema.safeParse`, proceeding unfiltered —
    implemented as specified.
  - Verify, 2026-08-07: `apps/cli/test/config-store.test.ts` (15 tests,
    pure temp-dir filesystem I/O — path resolution, save/load round
    trip, default-non-persistence, overwrite-not-merge, corrupt-JSON
    and failed-validation discard, clear) and
    `apps/cli/test/signals-list-saved-filters.test.ts` (7 tests, real
    `bin/hs.mjs` subprocess spawns against an unreachable API host,
    confirming `--save`/`--clear-saved`/auto-apply/no-auto-apply-when-
    flags-given all fire correctly before the expected network
    failure) — 22/22 new tests passing. Full `apps/cli` suite
    (`npx vitest run`) 47/47 passing, no regressions (was 25/25 before
    this milestone). `pnpm --filter @hiring-signals/cli
    typecheck`/`lint` clean; workspace-wide `pnpm -r typecheck`/`lint`
    clean afterward (6 of 7 projects). Manual smoke test against a real
    local `wrangler dev` (port 8798): `--save` with `--role
    cybersecurity` returned real signal data and persisted the profile;
    a follow-up `hs signals list` with no flags printed the exact
    stderr note and returned the same filtered result set from the
    live API; `--clear-saved` removed the file. Dev server torn down
    after verification.
  - Docs: `apps/cli/README.md` updated with a "Saved filter profiles"
    subsection and an updated Tests section listing the two new test
    files.

**Milestone N acceptance: N.1 (the milestone's only subtask) complete,
verified 2026-08-07 — saved filter profiles are fully built and tested.**

---

## Milestone O — Company hiring timeline API + page (investor/analyst view) — complete, landed 2026-08-08

Spec §1.4 (company-level signals), §10.1 (`/companies/[slug]` route
unspecified beyond "timeline + active roles"), §2.3 ("Trend charts" P2
— this milestone is structured-data foundation, not charts).

**Why this is the real differentiator:** no public tool gives a
structured, timestamped, evidence-backed record of *how a specific
company's hiring composition changed over time*. Already being
collected by ingestion; just needs a dedicated read path + legible
page. Constraint: never claim to represent intent/budget/confirmed
decisions — only observable public evidence (spec §11.3).

### O.1 — Company hiring timeline API endpoint — complete, landed 2026-08-08

`GET /api/v1/companies/:slug/timeline`

Time-bucketed summary of hiring activity for one company, queryable
by role category + date range. Pure read path over existing jobs +
signals.

- [x] `getCompanyHiringTimeline(client, { companyId, roleCategoryFilter?,
      since, until, bucketDays })` in `packages/db/src/companies-repo.ts`.
      Two round trips (`jobs` bucketed by `first_seen_at`/`last_seen_at`,
      `signals` bucketed by `first_detected_at`) rather than one UNION
      query — see that function's own header comment for the full
      reasoning. Returns `CompanyHiringTimelineBucket[]`
      (`packages/db/src/types.ts`): `bucketStart`/`bucketEnd`,
      `newJobsCount`, `closedJobsCount` (approximate, documented as
      such — see the function's own comment on why an exact close date
      isn't observable), `activeJobsCount` (snapshot at bucket end),
      `roleBreakdown`/`locationBreakdown` (top 5 by count), `signalTypes`
      (distinct types per bucket). Bucket width caller-selectable
      (7/14/30 days).
- [x] `GET /api/v1/companies/:slug/timeline` route
      (`apps/api/src/routes/companies.ts`), backed by
      `companyTimelineQuerySchema` (`packages/domain/src/
      company-timeline-query.ts`). `since`/`until` default to 90d-ago/now
      at request time (not schema-load time); window clamped to
      `MAX_TIMELINE_WINDOW_DAYS` (90d) with an explicit 400 (not a
      silent truncation) if exceeded — `resolveTimelineWindow` extracted
      as its own pure, directly-unit-tested function. Public/
      unauthenticated per §11.1 (`freeReadTier` middleware, same as
      every other route in this file). Envelope:
      `{ data: { company, buckets }, meta: { requestId, appliedFilters } }`.
- [x] Verify, 2026-08-08: `apps/api/test/routes/companies.test.ts`,
      6/6 passing (`resolveTimelineWindow`'s default-window,
      partial-default, exact-90-day-cap, over-cap-rejected,
      inverted-window-rejected, zero-width-rejected cases) — pure-function
      tests, no live D1 needed, confirmed independently via
      `npx vitest run test/routes/companies.test.ts` (26ms). Workspace-wide
      `pnpm -r typecheck`/`lint` clean across all 6 scaffolded projects,
      confirmed independently 2026-08-09.

### O.2 — `hs companies timeline` command (`apps/cli`) — complete, landed 2026-08-08

**Resolved 2026-08-07 (decided with the user): CLI, not a web page.**
Spec §10.1's `/companies/[slug]` route assumed `apps/web`, which was
deleted 2026-08-07. Investor-facing, dense, data-forward — same intent
as the original ASCII mockup below, adapted to a table a human or
agent reads in a terminal/response rather than a browser.

`hs companies timeline <slug> [--since --until --roles --bucket-days]`
— same params O.1's endpoint accepts, wired through `apps/cli/src/
api-client.ts` and `apps/cli/src/commands/companies.ts`. `--format
json` (CLI default, per F.1.1's own "no `--format` flag" scope note —
this command follows that same JSON-only convention, not the ASCII
`--format table` mockup originally sketched below) returns O.1's raw
bucket/signal/active-role response unchanged, for an agent to reformat
however the person actually needs it.

```text
ACME CORP (acme.example)
Monitored since 2026-03-01 · 3 sources · last sync 2h ago

BUCKET (14d)     NEW  CLOSED  ACTIVE  TOP ROLES
2026-06-01..14    3      1      9     ML(2) DevOps(1)
2026-06-15..28    4      0     12     ML(3) SWE(1)
...

SIGNALS (latest 5)
[82] hiring_burst / ML · 4 new roles in 14d · 3h ago
[71] multi_location / DevOps · US+DE+Remote · 1d ago
...

ACTIVE ROLES (12)
Senior ML Engineer · Remote US · observed 3h ago
...
```

The table above is the original mockup's intended shape (never
implemented as an actual `--format table` renderer, per F.1.1's
already-decided JSON-only scope) — kept here for context on the
milestone's original intent, not as a description of shipped output.

Export ties to `hs export signals --company <slug>` (F.1.3), not a
separate flag on this command — one export mechanism, reused.

- [x] Verify, 2026-08-08: `apps/cli` full suite (`npx vitest run`)
      51/51 passing, including the new `companies timeline exits
      non-zero with NETWORK_ERROR/req_none when the API host is
      unreachable` case in `test/cli-process.test.ts`, plus
      `test/api-client.test.ts` coverage for the new command — confirmed
      independently 2026-08-09. Workspace-wide `pnpm -r typecheck`/`lint`
      clean.

**Milestone O acceptance: both subtasks (O.1–O.2) complete, verified
2026-08-08 (commit `886cff2`), independently re-confirmed 2026-08-09 —
this section had been left unchecked in ROADMAP.md despite the work
already having landed; corrected here rather than re-implementing
already-shipped work.**

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

- [x] **P.1 — Industry/sector tagging for companies**
      (`infrastructure/scripts/update-company.mjs`) — complete,
      landed 2026-08-09.
  - `companies` already has `industry TEXT` but no ops script exposed
    it. Added `update-company.mjs` accepting `--id`, `--industry`,
    `--employee-band`, `--remote` flags — same `.mjs`-over-`wrangler d1
    execute --json` pattern as `update-source.mjs`/`add-company.mjs`.
    Industry stays free-text tag v1 ("fintech", "healthtech",
    "defense"); controlled vocabulary remains a future refinement, per
    this section's original scope.
  - Unlike `add-company.mjs`'s create-time `emptyToNull` (where an
    omitted flag and an explicit `""` both mean "leave unset"), a
    blank/whitespace-only `--industry`/`--employee-band` value here is
    rejected outright rather than silently clearing the column — this
    script is an explicit *update*, so a blank value passed to it is
    almost certainly a mistake worth failing loudly on.
  - Verify, 2026-08-09: `node --check` clean (no workspace `eslint`
    config covers `infrastructure/scripts/`, same as every other
    ops script in this directory — confirmed via `pnpm -r lint`
    only touching the 6 scaffolded workspace packages). Manual runs
    against local D1 (`nvm use 24.18.0` first): missing `--id`
    rejected (exit 1, usage printed); unknown `--id` rejected (exit 1,
    "No company found"); no fields passed rejected (exit 1, "Nothing
    to update"); blank `--industry`/`--employee-band` rejected (exit
    1) without touching the row; a real update
    (`--industry "AI Infrastructure" --employee-band "201-500"`
    against a seeded local fixture company) reported success and was
    independently confirmed via a follow-up `SELECT` to have actually
    persisted (`industry`/`employee_band`/`updated_at` all changed as
    expected); test fixture then reverted to its original values.

**Milestone P.1 acceptance: complete, verified 2026-08-09.**

- [x] **P.2 — Cross-company trend endpoint** `GET /api/v1/trends/hiring`
      — complete, corrected here 2026-08-09 (found already built and
      unmarked; see note below).
  - Query params: `roles` (comma-delimited, required ≥1), `industry`
    (optional free-text), `country` (optional ISO), `since` (default
    30d), `sort` (`acceleration_desc` / `volume_desc` /
    `newest_signal`, default `acceleration_desc`), `limit` (1–50,
    default 20) — `trendsQuerySchema`
    (`packages/domain/src/trends-query.ts`).
  - Returns ranked companies with most notable hiring activity:
    `{ company: { slug, displayName, industry, domain },
    newJobsCount, activeJobsCount, acceleration, topLocations,
    latestSignalType, latestSignalAt }` — `HiringTrendCompany`
    (`packages/db/src/types.ts`, moved there 2026-08-09 from
    `trends-repo.ts` so `apps/cli` can import it without pulling in
    `D1Client`, same pattern `CompanyHiringTimelineBucket` already
    follows). `acceleration` reuses `computeAcceleration(n14, n56)`
    from `packages/domain` — same formula, same version.
  - `getHiringTrends(client, { roleCategoryFilter, industryFilter?,
    countryFilter?, since, limit, sort })` in new
    `packages/db/src/trends-repo.ts` — two round trips (main
    aggregation + top-locations, same pattern
    `getCompanyHiringTimeline` uses), plus a third for latest-signal
    lookup; see that file's own header comment for the full reasoning.
  - Index: migration `0007_trends_role_first_seen_index.sql` adds
    `idx_jobs_trends ON jobs(role_primary, first_seen_at,
    country_code)` — `idx_jobs_filters` (migration 0001) leads with
    `company_id`, which is backwards for a cross-company ranking query
    with no company filter at all; see that migration file's own
    header comment.
  - Rate-limit: `freeReadTier`, same as every other public route. 5-min
    TTL KV cache keyed on every param that affects the result
    (`apps/api/src/routes/trends.ts`, same pattern as `facets.ts`).
  - **Found already fully implemented, unmarked, 2026-08-09:** the repo
    function, route, and migration all existed on disk (code reads as
    landed 2026-08-08/09 alongside P.1, going by the migration's own
    "P.2" references) but this checkbox was never checked and the route
    had no test file — corrected here rather than re-implementing
    already-shipped work, per this file's own top-level policy on
    Milestone O's identical situation.
  - Verify: `packages/db/test/trends-repo.test.ts`, 5 tests, live-D1
    (acceleration-sort ordering, industry filter, volume_desc sort,
    topLocations cap/count, zero-new-jobs-in-window exclusion) — already
    existed, read and confirmed matching the implementation 2026-08-09.
    **New 2026-08-09:** `apps/api/test/routes/trends.test.ts`, 5 tests —
    `resolveTrendsSince`/`buildTrendsCacheKey` extracted as pure
    functions out of the route handler (same `resolveTimelineWindow`
    precedent `companies.ts`/O.1 established) and unit-tested without a
    live D1/KV binding, matching `companies.test.ts`'s own file-level
    reasoning: the live-D1 ranking logic is already covered by
    `trends-repo.test.ts`, so the route test only needs to cover the
    route's own non-pass-through logic (since-defaulting, cache-key
    construction), not duplicate the repo suite.

- [x] **P.3 — `hs trends hiring` command (`apps/cli`)** — complete,
      landed 2026-08-09.
  - **Resolved 2026-08-07 (decided with the user): CLI, not a web
    page.** Originally written against `apps/web` (a `/trends` route
    per spec §10.1: role selector chip-toggle, industry/country
    filter, ranked company list, `[VIEW COMPANY →]` links), deleted
    2026-08-07. P.1/P.2 already deliver the actual product value —
    `GET /api/v1/trends/hiring` is a working, queryable endpoint
    independent of any UI; P.3 is just giving it a command.
  - `hs trends hiring --role backend [--industry --country --since
    --sort --limit]` — same params P.2's endpoint accepts, wired
    through new `apps/cli/src/commands/trends.ts` and a new
    `fetchHiringTrends` in `apps/cli/src/api-client.ts` (same
    `queryFromRecord`/envelope pattern as `fetchCompanyTimeline`).
    **Correction to this section's own original text, found while
    implementing:** F.1.1 dropped `--format table` CLI-wide before this
    command was ever built (see that milestone's own scope note, and
    `hs companies timeline`/O.2's identical resolution) — there is no
    `--format` flag anywhere in `apps/cli/src`, so this command follows
    that same JSON-only convention rather than the ASCII-table renderer
    originally sketched here. Output is always the raw JSON envelope
    P.2's route returns, for an agent to filter/re-rank further itself.
  - Registered as `hs trends hiring` (nested, matching `hs companies
    timeline`'s placement) in `apps/cli/src/main.ts`.
  - Verify, 2026-08-09: `apps/cli/test/api-client.test.ts`, 3 new tests
    for `fetchHiringTrends` (query serialization + envelope, no-params
    case, non-2xx error propagation) and
    `apps/cli/test/cli-process.test.ts`, 1 new test (`trends hiring`
    NETWORK_ERROR/req_none on an unreachable API host — same assertion
    shape as the existing `companies timeline` case).
  - **Sequence after Milestone F.1.2 + P.2** (needs the CLI's
    read-command pattern and the trends endpoint to exist first —
    dropped the prior "+ O.2" dependency since neither command's
    output depends on the other actually existing yet, only on their
    shared backend endpoints). Both satisfied.

**Milestone P acceptance: P.1–P.3 all complete, verified 2026-08-09.**

---

## Milestone Q — Hiring velocity score per company (investor-grade signal)

**Why this is the real moat:** existing signal score (§7.2) ranks
individual role-level signals. Investors need a single **company-level
hiring velocity score** answering "how aggressively is this company
building its technical team right now, vs. its own baseline?" Different
question from "is this specific job posting fresh?" Computable from
data already collected; no new ingestion beyond one migration.

- [x] **Q.1 — Hiring velocity score computation — complete, landed
      2026-08-09.** (`packages/domain/src/hiring-velocity.ts`)
  - Pure function `computeHiringVelocity(stats: CompanyActivityStats):
    HiringVelocityResult` — `CompanyActivityStats` (not
    `CompanyRoleStats` as this section originally sketched — that
    shape is H.2's per-*role* stats; Q.1 needs a company-*wide*
    aggregate across all roles, so a new interface was added rather
    than reusing H.2's) is the output of the new `getCompanyActivityStats`
    (Q.2, `packages/db/src/company-role-stats-repo.ts`).
  - Score formula (v1, versioned same as signal score):
    ```
    V = clamp(
      0.40 * acceleration + 0.25 * breadth
      + 0.20 * volume_norm  + 0.15 * persistence
    , 0, 1) * 100
    ```
    acceleration/breadth reuse `computeAcceleration` and
    `computeBreadth` from `signal-score.ts` (H.3, already built);
    volume_norm = `clamp(totalActiveJobs / 10, 0, 1)`; persistence =
    `clamp(daysSinceFirstSignal / 30, 0, 1)`.
  - Store as `companies.hiring_velocity_score` (INTEGER) +
    `companies.velocity_score_version` (TEXT) +
    `companies.velocity_computed_at` (TEXT). **Filename correction:**
    this section originally suggested `0005_company_velocity_score.sql`
    — 0005 was already taken by `0005_signals_dedup_index.sql` by the
    time this was actually built, so it landed as
    `0008_company_velocity_score.sql` (next free number after
    P.2's own `0007_trends_role_first_seen_index.sql`), all three
    columns DEFAULT NULL.
  - Verify: hand-computed unit tests in `hiring-velocity.test.ts`
    (cold=0, multi-loc-accel=high, stale=decay), matching
    `signal-score.test.ts`'s style. Typecheck/lint not run this
    session per explicit instruction — still outstanding before this
    is considered fully verified.

- [x] **Q.2 — Velocity score recompute in reconciliation — complete,
      landed 2026-08-09.** (`apps/api/src/jobs/reconciliation.ts`)
  - Daily reconciliation pass: after per-signal recomputes,
    `handleVelocityRecompute` runs once per company that had ≥1 signal
    genuinely reconciled this run (tracked via a `touchedCompanyIds`
    Set built during the score-reconciliation loop, so an unchanged
    company isn't recomputed for nothing). Calls the new
    `getCompanyActivityStats` (`packages/db/src/company-role-stats-repo.ts`
    — added alongside `getCompanyRoleActivityStats` as its all-roles
    sibling), `computeHiringVelocity`, then the new
    `updateCompanyVelocityScore` (`packages/db/src/companies-repo.ts`)
    to persist. Same per-row best-effort try/catch discipline as the
    rest of this file — one company's failure logs and moves on.
  - Verify: extended the first scenario in `reconciliation.test.ts`
    ("recomputes a stale active signal's score") to also assert the
    touched company's velocity score got persisted. Live-D1, not run
    this session per explicit instruction.

- [x] **Q.3 — Velocity score in trends API and CLI output — complete,
      landed 2026-08-09.**
  - Added `hiringVelocityScore` to P.2 `GET /api/v1/trends/hiring`
    response items (joined in `trends-repo.ts`'s main SELECT); added
    `sort=velocity_desc` (`trends-query.ts`'s Zod enum + `sortTrends`'s
    new branch — null/uncomputed scores sort last, not treated as 0).
  - Added `hiringVelocityScore` + `velocityComputedAt` to
    `GET /api/v1/companies/:slug` (and `GET /api/v1/companies` search —
    both go through `companies-repo.ts`'s shared `toSummary`).
  - Surfaced in `hs trends hiring` (P.3) via `Partial<TrendsQuery>`
    (picks up `velocity_desc` automatically) — CLI flag description and
    type cast updated. **Correction, 2026-08-09 (unchanged from prior
    note):** JSON-only output, no `--format table` (F.1.1 dropped that
    CLI-wide) — the raw `hiringVelocityScore` field is what the command
    carries, no separate CLI-layer formatting.
  - Disclaimer text ("Based on pace, breadth, and persistence of public
    hiring activity. Not a prediction of intent or budget.", spec
    §11.3) added as a shared `HIRING_VELOCITY_DISCLAIMER` constant
    (`packages/domain/src/hiring-velocity.ts`) — this was sketched in
    the prior version of this section but never actually implemented
    until this session. Wired into `meta.hiringVelocityDisclaimer` on
    `GET /api/v1/trends/hiring`, `GET /api/v1/companies`, and
    `GET /api/v1/companies/:slug` (not `.../timeline` — that route
    doesn't surface `hiringVelocityScore` at the top level, only nested
    under `company`, so it was left alone).
  - Verify: `trends-repo.test.ts` extended with a live-D1
    `velocity_desc` sort test (high/low/uncomputed companies, asserting
    null sorts last). `api-client.test.ts` extended: the existing
    `fetchHiringTrends` fixture now includes
    `meta.hiringVelocityDisclaimer`, plus a new describe block covering
    `fetchCompanies`/`fetchCompanyDetail` round-tripping
    `hiringVelocityScore` and the disclaimer unchanged. **Correction:**
    this section previously said the CLI test would cover
    `fetchHiringTrends`/`fetchCompanyTimeline` — `fetchCompanyTimeline`
    was never in scope for the disclaimer (see above); the actual
    second coverage point is `fetchCompanies`/`fetchCompanyDetail`.
    None of this run this session per explicit instruction.

---


## Milestone R — RSS feed (`GET /api/v1/feed.rss`)

Closes the notification gap identified in the usefulness analysis
(2026-08-06): a passive job seeker who has to actively invoke the CLI
(or ask their agent to) will get less consistent coverage than someone
using a feed reader with push-style delivery. RSS delivers push-style
alerts via any feed reader (Feedly, NetNewsWire, etc.) with no
accounts, no personal data, and no new infrastructure. Per-saved-search
filtering via URL query params means one feed URL per role/location
combination — better UX than a single email digest for the target
IT-specialist audience, and it's a pure `apps/api` route, independent
of whether a dashboard or CLI exists to construct the URL by hand.

**Dependencies:** No new schema or migrations — pure read path over
existing `signals-repo.ts`. Sequence after Milestone L (CSV export,
already built) since the route pattern is identical. Not actually
gated on Milestone F.1 (CLI) — the feed URL's query params are
constructed directly by whoever wants a feed; a feed URL is short
enough to write by hand or generate with a template, so this was never
a hard technical dependency.

### R.1 — RSS serializer (`lib/text/rss.ts`) — complete, landed 2026-08-07

- [x] Pure function `buildRssFeed(items: RssFeedItem[], meta: RssFeedMeta):
      string`, `lib/text/rss.ts`. **Row type correction found during
      implementation:** this section originally sketched
      `SignalListItem[]`, but R.2 (below) reuses `listSignalsForExport`'s
      read path — the same one `export.ts`'s CSV route already calls —
      so the real row shape is `SignalExportRow`
      (`packages/db`'s alias for `SignalRow`), and the real field names
      are `first_detected_at`/`last_detected_at`, not the
      `first_seen_at`/`last_seen_at` shorthand used in this file's prose.
      `rss.ts` types against the real shape, documented in its own header
      comment. No external dependency, same pattern as the sibling
      `lib/text/csv.ts`/`lib/text/content-hash.ts`.
- [x] Field mapping as specified: `<title>`←`headline`, `<link>`←
      `canonical_url` (omitted entirely when null — company-level
      aggregate signals with no job-linked evidence), `<pubDate>`←
      `first_detected_at` (RFC 822 via `Date#toUTCString()`),
      `<description>`←`summary` + score + signal type (HTML-escaped),
      `<guid isPermaLink="false">`←`signal_id`.
- [x] Verify: `apps/api/test/lib/rss.test.ts`, 7 tests (RSS 2.0 shell
      validity, empty feed with zero `<item>` elements, RFC 822 date
      formatting, XML escaping, `<guid>` uniqueness, `<link>` omission on
      null `canonical_url`, description content) — 7/7 passing, confirmed
      2026-08-07 via `npx vitest run test/lib/rss.test.ts`. Placed under
      `apps/api/test/lib/` rather than a new root-level `lib/`
      `vitest.config.ts` (this file's own prior note already flagged that
      choice as open) — `rss.ts` is pure fixture-input logic with no
      D1/AI/Vectorize dependency, so it's outside AGENTS.md's zero-mocks
      scope, same category as `packages/domain/test/*`. `pnpm --filter
      @hiring-signals/api typecheck` clean.

### R.2 — RSS route (`apps/api/src/routes/feed.ts`) — complete, landed 2026-08-07

- [x] `GET /api/v1/feed.rss`. **Param-name correction found during
      implementation:** this section originally listed `role`, `workMode`,
      `since` — the real wire contract (matching `signals.ts`/`export.ts`)
      is `roles` (comma-delimited), `locationMode`, `observedSince`;
      `feedQuerySchema` in `feed.ts` uses the real names, documented in
      its own header comment. Own inline `z.object({...})` (not
      `signalsQuerySchema.omit(...)`), matching `export.ts`'s convention
      and stated reasoning. Returns `Content-Type: application/rss+xml;
      charset=utf-8`. Mounted in `apps/api/src/index.ts` at the bare
      `/api/v1` prefix (not `/api/v1/feed`) since the route itself
      defines `/feed.rss` — gives the exact spec path.
- [x] `FEED_ROW_CAP = 50` + `listSignalsForFeed` added to
      `packages/db/src/signals-repo.ts`, next to `EXPORT_ROW_CAP`/
      `listSignalsForExport` — own constant and own query function
      (not `listSignalsForExport` with a caller-supplied limit), same
      truncate-and-report `{ items, truncated }` shape. Same
      `freeReadTier()` middleware as every other public route.
- [x] `Last-Modified` (most recent `first_detected_at`) + `ETag`
      (`lib/text/content-hash.ts`'s `computeContentHash` over the
      rendered XML) + `304 Not Modified` on matching `If-None-Match`,
      no KV caching.
- [x] Verify, 2026-08-07: `pnpm --filter @hiring-signals/api
      typecheck`/`lint` clean (0 errors, 0 warnings); `pnpm -r
      typecheck`/`lint` clean workspace-wide afterward. Manual `curl`
      against a real local `wrangler dev` (scratch port 8799, since
      8787 was already held by a stale/unresponsive `workerd` from a
      concurrent session): `GET /api/v1/feed.rss?roles=software_engineering`
      → `200`, valid RSS 2.0 XML, correct `Content-Type`/`ETag`/
      `Last-Modified`; repeat request with matching `If-None-Match` →
      `304 Not Modified`, confirmed; `?roles=cybersecurity` exercised
      both the `<link>`-present and `<link>`-omitted (null
      `canonical_url`) branches against real seeded local-D1 data;
      `?roles=backend` (invalid enum value) correctly `400`s via the
      existing Zod/error-handler chain. Dev server torn down after
      verification.

### R.3 — `hs feed-url` command (`apps/cli`) — complete, landed 2026-08-07

**Resolved 2026-08-07 (decided with the user): build it.** This
subtask was originally written against `apps/web` (a `buildFeedUrl`
helper, a `[RSS ↗]` link, an auto-discovery `<link>` tag) — all
deleted with the rest of `apps/web` on 2026-08-07. Re-scoped to the
CLI: R.1/R.2 (the feed itself) are pure `apps/api` work and were never
actually blocked by the dashboard's deletion — only *discoverability*
needed a new home, and the CLI is that home now that F.1 is committed.

- [x] `hs feed-url [--role --company --q --locationMode --country
      --source --signalType --minScore --observedSince]` — same flag
      names as `hs signals list` (F.1.2) and `hs export signals` (F.1.3),
      reusing `signalsQuerySchema.omit({ sort, cursor, limit })` rather
      than a second copy of flag parsing. No `--format` flag (F.1.1
      already dropped that CLI-wide — see that section's own scope
      note); output is always the one JSON object `{"url": "..."}` per
      design principle 1. `buildFeedUrl()` (pure, no network call) added
      to `apps/cli/src/api-client.ts`, reusing the same `queryFromRecord`
      serializer every other GET in that file uses, so the URL this
      builds is byte-identical in shape to what the CLI's own HTTP calls
      would send for the same params. Registered as a flat top-level
      command (`hs feed-url`, not nested), same placement as `hs facets`.
- [x] Verify, 2026-08-07: `apps/cli/test/feed-url.test.ts`, 6 tests
      (no-filter case, comma-joined `roles` array, every field
      `feedQuerySchema` accepts present in the query string,
      sort/cursor/limit never present, undefined/null filters omitted
      not empty-stringed, configurable `baseUrl`) — 6/6 passing; full
      `apps/cli` suite (`npx vitest run`) 25/25 passing, no regressions.
      `pnpm --filter @hiring-signals/cli typecheck`/`lint` clean;
      workspace-wide `pnpm -r typecheck`/`lint` clean afterward (6 of 7
      projects). Manual check: `node ./bin/hs.mjs feed-url --role
      software_engineering,cybersecurity --country US` printed exactly
      one JSON object with a correctly URL-encoded query string;
      re-run with `HS_API_BASE_URL` pointed at the same scratch
      `wrangler dev` instance R.2 verified against, the printed URL
      fetched directly and returned the same valid RSS 2.0 document —
      confirms the URL this command builds is the real, working feed
      URL, not just well-formed output.

**Milestone R acceptance: all three subtasks (R.1–R.3) complete,
verified 2026-08-07 — the RSS feed is fully built, routed, and
discoverable via the CLI.**
