# ROADMAP.md

Detailed, sequenced task breakdown for work remaining on HiringSignals.
`AGENTS.md` keeps the short status view and repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable
tasks before anyone starts writing code.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

**Status summary (last updated 2026-08-15):** All originally scoped
milestones (Phase 0 → R, G.1–G.5) are shipped and verified. Full
narrative/evidence for completed work lives in git history and
`CHANGELOG.md` — this file keeps only short landed-summaries plus the
two items still genuinely open below.

**Open-item count: 2**, both inside Milestone G:
1. G.3 — per-chunk-kill root cause still undiagnosed (code work, see below).
2. G.4 — "never point preview/staging at prod secrets" — a standing
   guardrail, deliberately kept unchecked, not a task to build today.

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

### G.3 follow-up — per-chunk-kill root cause (still open)

**Status as of 2026-08-14:** Not resolved by any fix shipped so far.

Context, briefly: `openai`'s board (700+ jobs, Ashby) kept dying
mid-run even after two real bugs were found and fixed in this
milestone — (1) subrequest-cap exhaustion on the upsert/lifecycle
write pair, fixed via `db.batch()`; (2) runs stacking indefinitely
because `next_poll_at` never advanced on an incomplete run, fixed via
`hasRecentRunningRun` scheduler guard (commit `35b6824`, deployed
2026-08-14 as version `6f82cd4a`). That second fix stopped the
stacking (verified live: concurrent-running count held flat across 2
cron ticks post-deploy) and let a single `openai` run be observed in
isolation for the first time — but it still stalls partway through
with **zero JS-catchable error and no `source_runs.error_code` ever
populated**. Watched live post-fix (run `26d1eb0a`): climbed to
`jobs_normalized=480` then stopped advancing ~15+ minutes later, same
symptom as before, now without multi-run contention as a possible
excuse.

- [ ] **Root-cause the silent per-chunk kill itself.** `wrangler tail`
      is unavailable from this environment's network egress
      (Cloudflare edge IPs aren't in the allowed domain list). Next
      step: either the Cloudflare dashboard's Observability/Logs view,
      or a local `wrangler tail` run (from a machine with unrestricted
      egress) during a live `openai` cron tick, to capture the actual
      platform error text. Once diagnosed, also remove the temporary
      `recordSourceRunProgress` diagnostic checkpoint
      (`packages/db/src/sources-repo.ts`) added 2026-08-13 — it was
      explicitly a diagnostic aid, not a permanent feature.

### G.4 — standing guardrail (not active work)

- [ ] If any deploy automation is ever added: never point preview/
      staging at production secrets or write bindings (spec §15.1).
      Currently moot — the environment-scope decision above rules out
      a separate preview/staging tier — but kept here as an explicit
      constraint in case that decision is ever revisited. Not a task
      to schedule.
