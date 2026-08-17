# ROADMAP.md

Detailed, sequenced task breakdown for work remaining on HiringSignals.
`AGENTS.md` keeps the short status view and repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable
tasks before anyone starts writing code.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

**Status summary (last updated 2026-08-17):** All originally scoped
milestones (Phase 0 → R, G.1–G.5) plus two later code-review/bug-hunt
passes (S, U) are shipped and verified. Full narrative/evidence for
completed work lives in git history and `CHANGELOG.md` — this file
keeps only short landed-summaries plus the items still genuinely open
below.

**Open-item count: 8**:
1. G.3 — root cause found and fixed in code (`SubrequestBudget`),
   deployed 2026-08-16. First live `openai` run under the new code
   completed successfully the same day (see below) — one data point,
   not yet the "a few real production runs" bar the diagnostic
   checkpoint's own removal condition sets. Watch a few more cron
   cycles before removing it.
2. G.4 — "never point preview/staging at prod secrets" — a standing
   guardrail, deliberately kept unchecked, not a task to build today.
3–8. T.1–T.6 — `apps/cli` code-review findings (2026-08-17), covering
   the `--watch`/company-watchlist feature work landed the same day.
   Two are real user-facing bugs (T.1, T.2); the rest are consistency/
   robustness gaps found in the same pass. See below.

V.1–V.4 (`apps/web` UI wiring gaps) — all four completed 2026-08-17.
See "Shipped milestones" and below for detail.

S.1–S.3 (2026-08-16 code-review findings) fixed and verified
2026-08-17 — see "Shipped milestones" below and CHANGELOG.md.

U.1–U.4 (2026-08-17 hybrid-search/query-schema bug hunt) fixed and
verified 2026-08-17 — see "Shipped milestones" below and CHANGELOG.md.

---

## How to use this file

- Work top to bottom within a milestone; milestones are ordered by
  hard dependency.
- A task is only checked off once code is written, the cited spec
  section re-read against what was built, and the listed verification
  command run with a real passing result.
- If a task turns out bigger than it looks, stop and split it into
  sub-tasks here rather than quietly expanding scope inside one commit.
- Update `CHANGELOG.md` when a milestone completes.

---

## Shipped milestones (summary only — see git history / CHANGELOG.md)

- **Phase 0–1, A–M**: scaffolding, D1 schema, write-path repos,
  classification/lifecycle, signal generation, scheduler/queue/ops
  scripts, 8 ATS adapters, dashboard (built then deleted 2026-08-07 in
  favor of the CLI), security audit + gap closure (G.1–G.2),
  signal-quality pass, semantic search (I.1–I.5), live-D1 test
  migration (J), `still_active` signal + latency metric (K), CSV
  export (L), bulk CSV import (M).

- **F.1 — CLI (`apps/cli`), primary interface.** Complete, landed
  2026-08-07. `apps/cli` is the intended entry point for an agent
  (JSON-by-default, machine-readable errors, no interactive prompts,
  thin client over `apps/api`). `--format table` fallback added
  2026-08-10 for human debugging (JSON stays default/unchanged).
  See `apps/cli/README.md` for exact invocations.

- **G.3 — Performance targets verification (spec §12).** Verified
  2026-08-05/11: page size ≤50 confirmed, Queues/D1 headroom not in
  question at current volume, uncached latency comfortably under
  target. Ingestion success/duplicate-rate measurement surfaced two
  real bugs, both root-caused and fixed same window: (a) stuck
  `source_runs` rows from exhausting the 1000-subrequest platform cap
  on large boards — fixed 2026-08-11 by batching the upsert/lifecycle
  D1 write pair (commit `7512473`); (b) `source-health.mjs` couldn't
  detect the stuck state — fixed same day with a `running_minutes`
  staleness check. One follow-up remains genuinely open — see below.

- **G.4 — CI/CD hardening (spec §15).** Environment scope decided
  2026-08-06 (stays simplified: Local + Production only, no
  Preview/Staging tier). Lint zero-warning enforced repo-wide.
  Rollback mechanically available (`wrangler rollback`), never
  drill-tested — low priority. Feature-flag gap for scoring-formula
  changes recorded as accepted, not built (no second formula in
  flight). One guardrail checkbox retained — see below.

- **G.5 — Acceptance criteria sign-off (spec §16).** Fully walked and
  PASS end to end, 2026-08-11. All 6 sub-items (§16.1–§16.3.6) passed
  live verification; 3 real gaps found and fixed in the process:
  custom-host port-injection bypass in `breezy`/`personio` adapters
  (§16.3.2), missing path-param schema validation on signal/company
  detail routes (§16.3.3), and no API-error-rate monitoring — closed
  by adding an Analytics Engine binding + `api-metrics.ts` middleware
  (§16.3.6).

- **N — Saved filter profiles (`apps/cli` local config file).**
  Complete, landed 2026-08-07. `~/.hiring-signals/config.json`
  (or `$XDG_CONFIG_HOME` equivalent); `--save`/`--clear-saved` flags
  on `hs signals list`, auto-applied when no filter flags given.

- **O — Company hiring timeline (API + CLI).** Complete, landed
  2026-08-08. `GET /api/v1/companies/:slug/timeline` (bucketed
  new/closed/active jobs, role/location breakdown, 90-day window cap)
  + `hs companies timeline <slug>`.

- **P — Cross-company hiring trend API + CLI.** Complete, landed
  2026-08-09. Industry tagging via `update-company.mjs` (P.1);
  `GET /api/v1/trends/hiring` ranked by acceleration/volume/velocity
  (P.2); `hs trends hiring` (P.3).

- **Q — Company-level hiring velocity score.** Complete, landed
  2026-08-09. `computeHiringVelocity` (acceleration/breadth/volume/
  persistence weighted formula) persisted to `companies.hiring_
  velocity_score`; recomputed in daily reconciliation; surfaced in
  trends API, company API, and CLI with the required spec §11.3
  disclaimer.

- **R — RSS feed (`GET /api/v1/feed.rss`).** Complete, landed
  2026-08-07. `buildRssFeed` serializer (R.1), route with ETag/
  Last-Modified/304 support (R.2), `hs feed-url` for discoverability
  (R.3).

- **S — Security/data-integrity code-review pass (`apps/api`,
  `packages/db`, `packages/adapters`).** 3 issues found and fixed
  2026-08-17: CSV export formula-injection (S.1), CORS reflected-
  origin + credentials misconfiguration plus an adjacent OPTIONS-
  preflight bug found in the same file (S.2), admin-auth strike-
  counter KV race (S.3). Full detail in CHANGELOG.md.

- **U — Hybrid-search / query-schema bug hunt.** 4 issues found and
  fixed 2026-08-17, starting from a prior trends-CLI investigation:
  missing regression coverage for an already-fixed CLI bug (U.1);
  `signalsQuerySchema.roles` silently treating an empty `--role` as
  "no filter" instead of erroring (U.2), duplicated unfixed on the
  public HTTP export/feed routes (U.3); and a semantic-search ranking
  bug where every hybrid-search result got the same similarity score
  regardless of which job actually matched (U.4), root-fixed via a
  new `matched_job_id` field on `findSignalsByJobIds`. Full detail in
  CHANGELOG.md.

---

## Open work

### G.3 follow-up — per-chunk-kill root cause (fix deployed, awaiting live confirmation)

**Status as of 2026-08-16:** Root cause found and fixed in code
2026-08-15; committed and deployed 2026-08-16. Not yet closed — needs
one real `openai` cron cycle observed post-deploy before the temporary
diagnostic checkpoint comes out and this item is checked off.

Context, briefly: `openai`'s board (700+ jobs, Ashby) kept dying
mid-run even after two real bugs were found and fixed in this
milestone — (1) subrequest-cap exhaustion on the upsert/lifecycle
write pair, fixed via `db.batch()`; (2) runs stacking indefinitely
because `next_poll_at` never advanced on an incomplete run, fixed via
`hasRecentRunningRun` scheduler guard (commit `35b6824`, deployed
2026-08-14 as version `6f82cd4a`). That second fix stopped the
stacking and let a single `openai` run be observed in isolation for
the first time — but it still stalled partway through with **zero
JS-catchable error and no `source_runs.error_code` ever populated**.

**Root cause (found 2026-08-15):** `JOBS_PER_CHUNK=40` was a fixed
job-count ceiling sized against a single "~14 subrequests/job
worst-case" estimate, but real per-job cost varies sharply — an
unchanged existing job returns early after ~2 D1 calls, while a
brand-new job pays the full ~14-call path. A 40-job chunk landing
disproportionately on new jobs (exactly what an unpolled board like
`openai`'s produces on its first run) could still blow the real
1,000-subrequest-per-invocation cap mid-chunk, below the JS layer
entirely.

**Fix:** stop estimating, start counting. `SubrequestBudget`
(`apps/api/src/jobs/ingest-consumer.ts`) tracks the real number of
Cloudflare-service calls issued so far this invocation, threaded
through `processNormalizedJob` and its callees. The chunk loop checks
remaining budget before each job and breaks — re-enqueuing the exact
next unprocessed job as the next chunk's offset — once
`SUBREQUEST_SAFETY_MARGIN=700` is reached, regardless of job count.
Self-correcting against real per-job cost variance instead of a
static guess. `JOBS_PER_CHUNK=40` kept as a secondary hard backstop
ceiling, not the primary boundary anymore. 6 new pure-function tests
(`apps/api/test/jobs/ingest-consumer-budget.test.ts`) covering the
budget math in isolation, since `ingest-consumer.test.ts` itself is
live-D1/manual-only.

- [x] **Root-cause and fix the silent per-chunk kill.** Committed
      (`12ae111`) and deployed 2026-08-16 (Worker version
      `d9960f2a-bb0c-4e67-a8c1-173496c466f1`). `pnpm -r typecheck`
      clean across all 6 workspace packages; `apps/api` lint
      zero-warning clean; `ingest-consumer-budget.test.ts` 6/6 passing.
- [x] **First live confirmation (2026-08-16).** Watched run
      `2dbb7ed4-44bd-40cc-921b-2fef7a544b13` (started
      2026-08-16T20:15:50.318Z, the first `openai` cron tick after
      deploy) through 4 continuation chunks — `jobs_normalized`
      progressed 400 → 640 → 720 → 746, reaching
      `status='success'`/`completed_at` at 20:33:39Z, `duration_ms`
      46641. `markSourceSuccess` fired correctly: source row's
      `last_success_at`/`next_poll_at` both populated (next poll ~6h
      out, matching `poll_interval_minutes`). First time in this
      incident's history an `openai` run has ever reached a terminal
      success state. Also found and closed 69 pre-fix orphaned
      `status='running'` rows (hourly since 2026-08-14, i.e. the
      `hasRecentRunningRun` guard's 45-min staleness window kept
      re-triggering hourly rather than stacking sub-hour, but the
      underlying per-run kill this fix addresses meant none of those
      hourly attempts ever completed) — same cleanup pattern as the
      577-row incident, `error_code='abandoned_run_cleanup'`.
- [ ] **Remove the temporary diagnostic checkpoint.**
      `recordSourceRunProgress`'s own removal condition is "a few real
      production runs," plural — one successful run (above) is a
      strong signal but not yet that bar. Watch 2-3 more `openai` cron
      cycles reach `status='success'` cleanly, then remove the
      checkpoint (`packages/db/src/sources-repo.ts`, called from the
      chunk loop every `PROGRESS_CHECKPOINT_INTERVAL=10` jobs in
      `apps/api/src/jobs/ingest-consumer.ts`) and close this item.

### G.4 — standing guardrail (not active work)

- [ ] If any deploy automation is ever added: never point preview/
      staging at production secrets or write bindings (spec §15.1).
      Currently moot — the environment-scope decision above rules out
      a separate preview/staging tier — but kept here as an explicit
      constraint in case that decision is ever revisited. Not a task
      to schedule.

### T — `apps/cli` code review findings (2026-08-17, --watch / company-watchlist pass)

Six issues found during a manual review of the `--watch` polling mode,
company-watchlist commands (`hs companies watch`/`unwatch`/
`list --watched`), and the `lastCheckedAt` incremental-default feature —
all landed the same day (F.1/N follow-on work, not tied to a spec
section directly, but in service of spec P1's "Company watchlists" and
the CLI's own F.1 "unattended agent" design principles). None shipped
broken by the original tests (typecheck/lint/93 CLI tests all passed at
merge time) — these are gaps the existing test suite's happy-path
coverage didn't reach, not regressions.

- [ ] **T.1 — `hs signals list --watch` dies permanently on the first
      transient failure.** `apps/cli/src/commands/signals.ts`'s watch
      loop (`while (true) { ... await fetchSignals(...) ... }`) has no
      per-tick try/catch. Any single `fetchSignals` failure — a
      transient network blip, momentary 500, DNS hiccup — throws out of
      the loop, propagates through citty's `runCommand` to
      `main.ts`'s top-level catch, and exits the entire process via
      `printErrorAndExit`. `--watch`'s own doc comment frames it as a
      long-running, unattended-agent-supervised feature ("Runs until
      the process is killed... an agent supervising this process is
      expected to manage its own lifecycle") — but as written, the
      *first* transient error kills it just as dead as a fatal one,
      which defeats the "detect a posting before the crowd, running
      unsupervised" premise this feature exists for.
      Fix: wrap each tick's `fetchSignals` call in its own try/catch
      inside the loop. On failure, print a structured JSON error line
      to stderr (same `{error: {code, message, requestId}}` shape
      `printErrorAndExit` already uses, so `| jq` consumers see a
      consistent shape whether it's a tick failure or a fatal one) and
      `continue` the loop rather than exiting — a scripted supervisor
      can watch for repeated tick failures and decide to kill the
      process itself if it wants that behavior, but a single blip
      should never silently end an unattended watch session. Add a
      real subprocess test: point `--watch` at a host that fails the
      first N requests then succeeds (or use the existing unreachable-
      host harness for a bounded number of ticks) and assert the
      process is still running/printing after a tick failure, not
      exited.
- [ ] **T.2 — `hs companies list --watched` fails entirely if any one
      watched company 404s.** `apps/cli/src/commands/companies.ts`'s
      `--watched` branch resolves every saved slug via
      `Promise.all(slugs.map((slug) => fetchCompanyDetail(config, slug)))`.
      `Promise.all` rejects as soon as any single promise rejects — so
      one stale, renamed, or typo'd slug in the watchlist (a real
      scenario: companies get acquired, rebrand, or a slug is
      mistyped when watching) takes down the *entire* list, and the
      user sees a bare `NOT_FOUND`/`ApiClientError` instead of the
      N-1 companies that would have resolved fine. `watch`'s own doc
      comment describes this as a per-item concern ("`list --watched`
      will simply surface a NOT_FOUND error at read time for a bad
      slug, same as `companies get` would") — implying a scoped,
      single-company failure, but `Promise.all` makes it all-or-
      nothing, not per-item, so the code doesn't match the comment's
      own stated intent.
      Fix: switch to `Promise.allSettled`, return fulfilled results in
      `data` as today, and surface rejected slugs in a new
      `meta.failures: [{slug, error: {code, message}}]` array (or
      similar) rather than throwing. Update the doc comment to match
      whatever the real per-item-failure shape ends up being. Add a
      test with a watchlist containing one good slug and one slug that
      404s, asserting the good company still comes back in `data` and
      the exit code is still 0 (a partial watchlist read succeeding is
      not a command failure).
- [ ] **T.3 — `clearSavedFilters` bypasses the `writeConfigFile` error
      wrapper.** `config-store.ts`'s `saveFilters`/`watchCompany`/
      `unwatchCompany` were all fixed (2026-08-17, alongside T's
      sibling work) to route their writes through `writeConfigFile`,
      which wraps a raw fs error (EACCES, ENOSPC, etc.) in a clean,
      CLI-authored message + `cause`. `clearSavedFilters`'s
      "config file has other keys left, rewrite without savedFilters"
      branch still calls raw `writeFile` directly, so a write failure
      there surfaces the old unwrapped Node error message —
      inconsistent with every sibling write path in the same file as
      of today. (Its delete branch, `rm(path, {force: true})`, is a
      separate, lower-risk case — `force: true` already swallows
      ENOENT, though a permissions failure there would still be
      unwrapped too.)
      Fix: route both of `clearSavedFilters`'s write paths (the
      rewrite-without-savedFilters branch, and arguably the `rm` call
      too, for the same consistency reason) through `writeConfigFile`
      or an equivalent wrapper. Add a test forcing the same
      unwritable-parent-directory failure the T.3-adjacent tests in
      `config-store.test.ts` already use for `saveFilters`/
      `watchCompany`, asserting `clearSavedFilters` now throws the
      same clean wrapped message.
- [ ] **T.4 — Double-cast type erasure in `signals.ts`'s
      `pickFilterFlags` call site.** `signals.ts`'s `list` command
      calls `pickFilterFlags(args as unknown as Record<string, unknown>)`
      — casting through `unknown` to force citty's typed `args` object
      into `Record<string, unknown>`. A cast through `unknown` (rather
      than a direct cast) is the compiler's way of saying the two types
      don't actually overlap the way the code assumes; routing around
      that instead of understanding why suppresses a real signal if
      citty's `args` shape (or `defineCommand`'s inferred arg types)
      changes in a future citty upgrade — the cast would keep
      "succeeding" while silently passing the wrong shape through.
      Fix: investigate the actual type mismatch (likely citty's
      per-flag inferred types, e.g. `string | boolean | undefined`,
      not lining up with `pickFilterFlags`'s `Record<string, unknown>`
      parameter) and either type `pickFilterFlags`'s parameter more
      precisely against citty's real inferred `args` type, or narrow
      field-by-field before the call instead of casting the whole
      object away. No behavior change expected — this is a type-safety
      cleanup, not a functional bug — so the existing test suite
      passing unchanged is the verification bar, plus confirming
      `pnpm --filter @hiring-signals/cli typecheck` stays clean without
      the `as unknown as` escape hatch.
- [ ] **T.5 — `--watch` + `--save`: a mid-tick process kill can
      replay up to one tick's worth of already-seen signals.**
      `signals.ts`'s watch loop calls
      `recordLastCheckedAt(tickStartedAt)` *after* each successful
      `fetchSignals` call, when `usedSavedProfile` is true. If the
      process is killed (SIGINT/SIGTERM/crash) after a tick's
      `fetchSignals` succeeds and prints, but before that tick's
      `recordLastCheckedAt` write completes, the next bare
      `hs signals list` picks up `observedSince` from the *previous*
      tick's timestamp, not the just-completed one — so a restart can
      reprint signals already shown in the killed tick. Likely a
      narrow window in practice (the gap between "fetch succeeded" and
      "one local fs write completes" is small), and re-showing an
      already-seen signal is a much softer failure mode than the
      inverse (silently dropping one) — but it's unverified either
      way, and this is exactly the boundary condition the
      `lastCheckedAt` feature exists to get right.
      Fix: add a test that simulates a kill between tick-fetch-success
      and the `recordLastCheckedAt` write (e.g. by calling the two
      steps' underlying functions directly rather than the full watch
      loop, since the loop itself can't be killed mid-await from
      within a test easily) and confirms the *documented* behavior
      (replay-safe overlap, not silent drop) — either the current
      order is already correct and just needs the test to prove it, or
      swap the write to happen before the print if "never replay" is
      actually the intended guarantee.
- [ ] **T.6 — No `SIGINT`/`SIGTERM` handling in `--watch` mode.** The
      watch loop relies entirely on Node's default signal handling to
      exit on Ctrl-C — there's no custom handler to print a final
      "stopped watching" line, flush anything, or distinguish a clean
      user-initiated stop from any other exit path. Low priority (the
      loop has no in-memory state that needs flushing today — every
      tick is already a complete, independent print), but worth an
      explicit decision rather than defaulting silently: either add a
      minimal `process.on("SIGINT", ...)` handler that prints a clean
      one-line stderr note before exiting 0, or confirm in this file
      that silent-default-exit is the intended contract for a
      script/agent-driven process (no human is expected to be watching
      the terminal for a friendly message) and close this without a
      code change.

### V — `apps/web` UI wiring gaps (identified 2026-08-17)

Four gaps found during a thorough audit of the web UI's backend
integration. The API client (`src/lib/api-client.ts`) is fully wired
to every deployed endpoint — all pages fetch real data. These are
design deferrals and one UX omission, not broken wiring.

- [x] **V.1 — Root `/` page shows a text link instead of redirecting.**
      `apps/web/src/app/page.tsx` renders a plain `<Link>` directing
      users to `/signals` rather than automatically redirecting there.
      A user (or search engine) landing on `/` sees a bare paragraph
      with a link instead of the signal feed.
      Fix: replace the page body with a `<meta http-equiv="refresh">`
      or, better, a Next.js `redirect()` call from the server component
      (`import { redirect } from "next/navigation"; redirect("/signals");`).
      No UI component changes needed. Verification: `next build` clean,
      navigating to `/` in dev drops the user at `/signals`.

- [x] **V.2 — Signal feed has no "sources haven't run yet" / "all
      sources are stale" status state (ROADMAP F.6).** `signal-feed.tsx`
      has loading/error/empty states but no way to distinguish "empty
      because no ingestion has ever run" from "empty because no roles
      match your filters." `masthead.tsx` already calls `GET /api/v1/sources`
      to derive a "last sync" label — that same data can drive a
      contextual note in the feed's empty state.
      Fix: when `state.items.length === 0` and no filters are active,
      call `GET /api/v1/sources` (already implemented as
      `fetchSources` — add it to `api-client.ts` if missing, or reuse
      `masthead.tsx`'s inline fetch). If all sources have
      `last_success_at = null`, show "No ingestion has run yet —
      check back after the first scheduled sync." If the most recent
      `last_success_at` is >2 hours old, show "Sources may be stale
      (last sync: Xh ago)." Otherwise show the existing "No signals
      match this query" + Reset filters CTA. Verification: typecheck
      clean; manual test with an empty-filter state in dev against a
      running API.

- [x] **V.3 — `ScoreBreakdown` shows a generic formula description
      instead of real per-signal component values (spec §10.5).**
      `score-breakdown.tsx` renders a static list of formula weights
      because `GET /api/v1/signals/:id` does not return the R/V/A/B/Q
      score components. The components are computed in
      `computeNewJobScore` (`packages/domain/src/signal-score.ts`) at
      write time but never persisted to the `signals` table or included
      in `SignalDetail`.
      Fix (three-part):
      1. Add `score_freshness`, `score_volume`, `score_acceleration`,
         `score_breadth`, `score_confidence` columns to the `signals`
         table (new D1 migration, nullable for existing rows).
      2. Persist them in `signals-write-repo.ts` at upsert time
         alongside `score`.
      3. Expose them on `SignalDetail` (`packages/db/src/types.ts`) and
         include them in the `GET /api/v1/signals/:id` response.
      4. Update `score-breakdown.tsx` to render the real per-signal
         values when present, falling back to the existing generic
         description for older rows where the columns are null.
      Verification: `pnpm -r typecheck` clean; a `GET /signals/:id`
      on a freshly-ingested signal returns the five component fields;
      `score-breakdown.tsx` renders them instead of the generic text.

- [x] **V.4 — `TrendBlock` on signal detail links out instead of
      showing role-scoped 7/30/90-day activity (spec §10.5).** The
      spec asks for "active matching roles over 7, 30, and 90 days"
      scoped to the signal's (company, role) pair. Today `trend-block.tsx`
      links to the company's full timeline page (`/companies/[slug]`)
      because `GET /api/v1/companies/:slug/timeline` is company-wide,
      not role-scoped, and `getCompanyRoleActivityStats` (the
      per-role point-in-time query) isn't exposed as a time series.
      Fix (two-part):
      1. Add a `GET /api/v1/companies/:slug/role-activity` route (or
         extend `/timeline` with a `role=` filter) that returns
         new/active job counts for a single (company, role) pair
         bucketed at 7, 30, and 90 days. Backed by a new or extended
         repo query over the existing `job_observations` table — no
         schema change required, only a new read query.
      2. Wire `trend-block.tsx` to call this endpoint (add to
         `api-client.ts`) and render the three bucket values inline
         instead of the current link-out. Keep the link to the company
         timeline page as secondary context below the inline numbers.
      Verification: `pnpm -r typecheck` clean; `GET /companies/:slug/
      role-activity?role=software_engineering` returns three buckets;
      `trend-block.tsx` renders them on a real signal detail page in dev.
