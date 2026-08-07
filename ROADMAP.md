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

## Milestone F.1 — CLI (`apps/cli`), primary interface — planned, decided with the user 2026-08-07

**Not started. No code exists yet** — this section describes the target
shape so implementation has a spec to build against. `apps/web` was
deleted 2026-08-07, so there is currently no working interface at all —
the API (`apps/api`) is reachable directly via HTTP in the meantime,
but nothing here has landed yet.

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

**Open decision, F.1.1 should resolve before writing code:**
`signalsQuerySchema` (the query-param validator `apps/api/src/routes/
signals.ts` uses) is defined inline in that route file, not exported
from `packages/domain`. If the CLI wants `hs signals list`'s flags to
validate against the *exact* schema the API enforces (so a new filter
field added to the API can't silently drift out of sync with the CLI's
flag list), `signalsQuerySchema` needs to move to `packages/domain` (or
be re-exported from `apps/api`) as part of F.1.1, before F.1.2's read
commands are built against it.

- [ ] **F.1.1 — CLI scaffold (`apps/cli`)**: new workspace package.
  Argument parsing: `citty` (Unjs) or `commander` — either has an
  agentic-friendly mode (no interactive fallback prompts by default);
  pick one and record the choice here once decided, don't leave it open
  past this subtask. `--format json|table` global flag (default
  `json`). Shared HTTP client (new `apps/cli/src/api-client.ts`,
  written fresh against the pattern above, not copied) importing
  `apiErrorSchema` from `@hiring-signals/domain`. `ADMIN_SECRET`/API
  base URL from env vars or `--config`, never an interactive login
  flow. Resolve the `signalsQuerySchema` export-location decision above
  as part of this subtask, since F.1.2 depends on it.
- [ ] **F.1.2 — Read commands**: `hs signals list [--role --company --q
  --location-mode --country --source --signal-type --min-score
  --observed-since --cursor]`, `hs signals get <signalId>`, `hs
  companies list [--filters]`, `hs companies get <slug>`, `hs facets`,
  `hs sources list`. Each maps directly to its existing `GET` route and
  passes the same query parameters through unchanged.
- [ ] **F.1.3 — Export command**: `hs export signals [--same filters as
  signals list] [--out <path>]` — streams the existing CSV export route
  to a file or stdout.
- [ ] **F.1.4 — Admin commands**: `hs admin source run <sourceId>
  --yes`, `hs admin scheduler flush --yes`, `hs admin reconcile --yes`
  — thin wrappers over the existing `POST /admin/*` routes, each
  requiring the explicit `--yes` flag per principle 3 above.
- [ ] **F.1.5 — Tests**: fixture-driven tests against a mocked
  `apps/api` (same pattern as `packages/adapters`'s fixture tests), plus
  exit-code and stderr-shape assertions for the error path.
- [ ] **F.1.6 — Docs**: `apps/cli/README.md` with one example invocation
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

**Milestone-level acceptance criteria (all six subtasks done, plus):**
- Every command in F.1.2–F.1.4's target surface implemented and callable
  against a real local `apps/api` (`wrangler dev`), not just against
  F.1.5's mocks.
- `pnpm --filter @hiring-signals/cli typecheck`/`lint`/`test` clean, and
  workspace-wide `pnpm -r typecheck`/`lint` still clean afterward (a
  new workspace package must not break existing ones).
- Manual smoke test: pipe `hs signals list --role backend | jq .` and
  confirm valid, parseable JSON on stdout with nothing else mixed in —
  this is the single concrete check for principle 1 (structured output
  by default) actually holding, not just being stated as a goal.
- `README.md`'s Layout table and `llm.txt`'s Architecture section
  updated from "planned, not started" to "complete" once this lands —
  both currently describe `apps/cli` as not-yet-started and need a
  matching update the same day F.1 ships.

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

## Milestone N — Saved filters (local config file, no backend)

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

- [ ] **N.1 — Filter profile save/load** (`apps/cli`)
  - `hiring-signals signals list --role backend --location london --save`
    writes the current filter flags to a local config file
    (`~/.hiring-signals/config.json` or `$XDG_CONFIG_HOME` equivalent)
    under a `savedFilters` key. Plain JSON of `signalsQuerySchema`
    params — same schema Milestone N originally specified, just a
    different storage location.
  - `hiring-signals signals list` with **no** filter flags and a saved
    profile present: use the saved filters automatically (a CLI has no
    URL to treat as source of truth the way a browser tab does, so
    "no flags supplied" is the CLI's equivalent of "no URL params" —
    apply the saved profile rather than defaulting to unfiltered).
    Print a one-line stderr note (`Using saved filters: role=backend,
    location=london`) so the behavior is visible, not silent — this
    preserves the original "don't silently apply saved filters"
    intent even though there's no banner UI to show it in.
  - `hiring-signals signals list --clear-saved` removes the saved
    profile.
  - No v1 versioning — if the stored JSON fails `signalsQuerySchema`
    parsing on load, silently discard it and proceed unfiltered (same
    fallback behavior originally specified, adapted from "show
    re-save prompt" to "just proceed," since a CLI has no persistent
    UI to show a prompt in between invocations).
  - **Sequence after Milestone F.1**, not Milestone F — this now
    depends on the CLI existing, not the deleted dashboard.

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
decisions — only observable public evidence (spec §11.3).

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
      (7/14/30 default 14). Public/unauthenticated per §11.1.
      Envelope: `{ data: { company, buckets }, meta: { requestId } }`.

### O.2 — `hs companies timeline` command (`apps/cli`)

**Resolved 2026-08-07 (decided with the user): CLI, not a web page.**
Spec §10.1's `/companies/[slug]` route assumed `apps/web`, which was
deleted 2026-08-07. Investor-facing, dense, data-forward — same intent
as the original ASCII mockup below, adapted to a table a human or
agent reads in a terminal/response rather than a browser.

`hs companies timeline <slug> [--since --until --roles --bucket-days]`
— same params O.1's endpoint accepts. `--format table` output:

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

No bar-chart rendering (the original mockup's `████` bars were a
browser-canvas concept) — a monospace count column serves the same
"see the trend at a glance" purpose in a table, and is what
`--format json` already returns structured, unrendered. `--format
json` returns O.1's raw bucket/signal/active-role arrays unchanged,
for an agent to reformat however the person actually needs it.

Export ties to `hs export signals --company <slug>` (F.1.3), not a
separate flag on this command — one export mechanism, reused.

- **Sequence after Milestone F.1.2 + O.1** (needs the CLI's read-command
  pattern and the timeline endpoint to exist first).

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

- [ ] **P.3 — `hs trends hiring` command (`apps/cli`)**
  - **Resolved 2026-08-07 (decided with the user): CLI, not a web
    page.** Originally written against `apps/web` (a `/trends` route
    per spec §10.1: role selector chip-toggle, industry/country
    filter, ranked company list, `[VIEW COMPANY →]` links), deleted
    2026-08-07. P.1/P.2 already deliver the actual product value —
    `GET /api/v1/trends/hiring` is a working, queryable endpoint
    independent of any UI; P.3 is just giving it a command.
  - `hs trends hiring --role backend [--industry --country --since
    --sort --limit]` — same params P.2's endpoint accepts. `--format
    table` prints the ranked company list as columns (`company,
    newJobs, active, acceleration, topLocations, latestSignal`);
    `--format json` (CLI default) returns P.2's response unchanged,
    for an agent to filter/re-rank further itself. No charts, same
    "the ranked table is the product" framing the original design had
    — a CLI table delivers that as directly as the deleted mockup did.
  - **Sequence after Milestone F.1.2 + P.2** (needs the CLI's
    read-command pattern and the trends endpoint to exist first —
    dropped the prior "+ O.2" dependency since neither command's
    output depends on the other actually existing yet, only on their
    shared backend endpoints).

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
    `getCompanyRoleActivityStats` (H.2, already built) aggregated
    across *all* role categories for a company.
  - Score formula (v1, versioned same as signal score):
    ```
    V = clamp(
      0.40 * acceleration + 0.25 * breadth
      + 0.20 * volume_norm  + 0.15 * persistence
    , 0, 100) * 100
    ```
    acceleration/breadth reuse `computeAcceleration` and
    `computeBreadth` from `signal-score.ts` (H.3, already built);
    volume_norm = `clamp(totalActiveJobs / 10, 0, 1)`; persistence =
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

- [ ] **Q.3 — Velocity score in trends API and CLI output**
  - Add `hiringVelocityScore` to P.2 `GET /api/v1/trends/hiring`
    response items; add `sort=velocity_desc` sort option.
  - Add `hiringVelocityScore` + `velocityComputedAt` to
    `GET /api/v1/companies/:slug` response.
  - Surface in `hs trends hiring` (P.3) and `hs companies timeline`
    (O.2) `--format table` output as a labeled column/line — no visual
    badge treatment (spec §11.4's chartreuse-at-80+ styling was a
    dashboard concept, moot once O.2/P.3 are CLI tables); `--format
    json` already carries the raw field once Q.3's API work lands, so
    the CLI layer only needs to print it. Same disclaimer text inline:
    "Based on pace, breadth, and persistence of public hiring
    activity. Not a prediction of intent or budget." (spec §11.3).
  - Verify: route tests asserting fields present in both endpoints;
    CLI output test asserting the disclaimer string appears in
    `--format table` output.

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

### R.1 — RSS serializer (`lib/text/rss.ts`)

Pure function `buildRssFeed(signals: SignalListItem[], meta: { selfUrl:
string, title: string, description: string, lastBuildDate: string }):
string` — returns a valid RSS 2.0 XML string. No external dependency,
same pattern as the sibling `lib/text/csv.ts`/`lib/text/content-hash.ts`
(repo-root `lib/text/`, not under `packages/`); route imports it the
same relative way `export.ts` imports `toCsvDocument`: `../../../../lib/
text/rss`.

Field mapping:

| RSS 2.0 field | Signal field |
|---|---|
| `<title>` | `headline` |
| `<link>` | canonical evidence URL (first evidence row's `canonical_url`) |
| `<pubDate>` | `first_seen_at` (RFC 822 format) |
| `<description>` | `summary` + score + signal type, HTML-escaped |
| `<guid isPermaLink="false">` | `signal_id` |

Channel `<title>` built from active filter params (e.g. "Hiring Signals
— backend · london"). `<lastBuildDate>` = most recent `first_seen_at`
in the result set, or current time if feed is empty.

Verify: unit tests covering HTML escaping, RFC 822 date formatting,
empty feed (valid XML, zero `<item>` elements), and `<guid>` uniqueness
across items. Note: `lib/text/csv.ts` and `lib/text/content-hash.ts`
(the two existing siblings this pattern is modeled on) have no test
files anywhere in the repo and there's no root-level vitest config for
`lib/` — confirmed by search, not assumed. `rss.ts`'s tests need a new
`vitest.config.ts` for `lib/` (or import into an existing package's
test suite, e.g. `apps/api/test/`, if that's simpler) — call this out
explicitly during implementation rather than copy a "same as csv.ts"
pattern that doesn't actually exist yet.

### R.2 — RSS route (`apps/api/src/routes/feed.ts`)

`GET /api/v1/feed.rss` — same query params as `GET /api/v1/signals`
(`role`, `company`, `source`, `signalType`, `workMode`, `minScore`,
`since`, `q`). Hard cap: 50 items (RSS readers poll frequently;
pagination not applicable to feed format). Returns
`Content-Type: application/rss+xml; charset=utf-8`.

Query schema: duplicate it inline (own `z.object({...})`, same fields
minus `sort`/`cursor`/`limit`), matching `export.ts`'s own choice and
stated reasoning (own header comment: a route's contract should be
legible on its own without needing to open `signals.ts` to see what's
accepted) — not `signalsQuerySchema.omit(...)`. Same convention both
places, not a new decision to make here.

Reuses `listSignalsForExport` from `signals-repo.ts` as the read path
(same function the CSV export route calls), different serializer on
top — but note its real signature is `(client, params: Omit<
ListSignalsParams, "sort" | "cursor" | "limit">)`: no caller-supplied
`limit`, capping happens internally via `EXPORT_ROW_CAP` (currently
2000, export.ts's constant). The feed's 50-item cap is a *different*
number for a *different* reason (poll frequency, not one-time-dump
size), so it needs its own constant — add `FEED_ROW_CAP = 50` next to
`EXPORT_ROW_CAP` in `signals-repo.ts`, following the same truncate-
and-report shape (`{ items, truncated }`) rather than passing 50 into
the existing function as if it took a limit argument. Same
`freeReadTier()` rate-limit middleware as every other public route
(no-arg factory, `apps/api/src/middleware/anti-abuse.ts`).

No KV caching in v1 — respond with `Last-Modified` (most recent
`first_seen_at`) and `ETag` (content hash via
`lib/text/content-hash.ts`). A conditional `304 Not Modified` on
matching `If-None-Match` is cheaper than a KV write on every RSS
reader poll.

Verify: `pnpm --filter @hiring-signals/api typecheck`/`lint` clean;
manual `curl` confirming valid XML, correct `Content-Type`, and `304`
on repeat request with matching `If-None-Match`.

### R.3 — `hs feed-url` command (`apps/cli`)

**Resolved 2026-08-07 (decided with the user): build it.** This
subtask was originally written against `apps/web` (a `buildFeedUrl`
helper, a `[RSS ↗]` link, an auto-discovery `<link>` tag) — all
deleted with the rest of `apps/web` on 2026-08-07. Re-scoped to the
CLI rather than left open: R.1/R.2 (the feed itself) are pure
`apps/api` work and were never actually blocked by the dashboard's
deletion — only *discoverability* needed a new home, and the CLI is
that home now that F.1 is committed.

`hs feed-url [--role --company --q --location-mode --country --source
--signal-type --min-score --since]` — same flag set as `hs signals
list` (F.1.2), reusing that command's flag-parsing/validation rather
than a second copy. Builds and prints the full `/api/v1/feed.rss?...`
URL against the configured API base. `--format json` (the CLI global
default) wraps it as `{"url": "..."}`; `--format table` prints the
bare URL on one line for a human to paste into a feed reader.

**Why build it, not skip:** the target user is mostly an agent acting
for a person, but an agent acting on `hs feed-url`'s own output can
still hand a real RSS URL to a person who wants push-style delivery
in Feedly/NetNewsWire — that's a small addition (reuses F.1.2's flag
parsing entirely, no new validation logic) for a real capability gap
(the CLI itself has no push mechanism; RSS is how "notify me later"
gets covered without building one). Not building a `--save`/`--watch`
polling loop into the CLI itself — that's a separate feature, not
implied by this command.

Verify: unit test asserting flag-to-query-param mapping matches R.2's
accepted param set exactly (same fixture list, so drift between the
two is caught); manual check that a printed URL, opened directly,
returns valid RSS (reuses R.2's own manual-verification step).

**Sequence after Milestone F.1.2** (needs `signals list`'s flag
parsing to exist first) **and R.2** (needs the route to point at).
