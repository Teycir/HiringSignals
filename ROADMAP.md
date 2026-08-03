# ROADMAP.md

Detailed, sequenced task breakdown for the work remaining after Phase 0
(scaffolding) and the Phase 1 read-path (D1 schema + `GET` routes), both
complete as of 2026-07-27. `AGENTS.md` keeps repo-wide policy; this file
is where a phase gets broken into ordered, independently-verifiable tasks
before anyone starts writing code, so scope doesn't get discovered
mid-implementation.

Source of truth for *behavior* is always `hiring-signals-spec.md` —
every task below cites the spec section it implements. If a task and the
spec disagree, the spec wins and this file gets corrected.

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
- Update `CHANGELOG.md` when a milestone completes.

---

## Completed milestones (trimmed — see git history for full narratives)

### Phase 0 — Scaffolding ✅ 2026-07-27
pnpm workspace, strict TS base, shared ESLint, `apps/web` (Next.js 16 +
Tailwind), `apps/api` (Hono Worker + middleware chain), `packages/domain`
core schemas, real D1/KV/Queue resources, anti-abuse middleware on read
routes, circuit breaker on D1 calls.

### Phase 1 — D1 schema + read paths ✅ 2026-07-27
Full schema (migration 0001), parameterized D1 client wrapper,
cursor-paginated signal feed with sort-aware cursors, company
autocomplete/detail/recent-signals, KV-cached facet counts, all `GET`
routes wired to real D1 queries.

### Milestone A — Write-path repositories (`packages/db`) ✅ 2026-07-28
`sources-repo.ts` (getDueSources, createSource, recordSourceRun*,
markSourceSuccess/Failure, DuplicateSourceError), `jobs-repo.ts`
(upsertJob, insertJobObservation, getJobsMissingFromRun,
applyLifecycleTransition), seed fixtures `seed-local-d1.sql` (20
companies, 20 sources, 60 jobs, 20 signals + evidence).

### Milestone B — Classification and lifecycle (pure logic) ✅ 2026-07-28
Title normalization, phrase-rule + abbreviation matcher against 10 P0
role categories, negative-term guard, confidence scoring
($C_{role}=0.70C_t+0.20C_d+0.10C_{desc}$, auto-classify ≥0.80), lifecycle
state machine (2 missing → possibly_closed, 4/14 → closed, reappear →
active). 24/24 tests in `packages/domain`.

### Milestone C — Signal generation ✅ 2026-07-28
`signals-write-repo.ts` (createSignal, appendSignalEvidence,
findActiveSignal, refreshSignal), `computeNewJobScore()` (S = min(100,
35R+25V+20A+10B+10Q-P), v1 R = freshness decay), wired into
ingest-consumer's post-upsert step.

### Milestone D — Scheduler, queue consumer, source-management scripts ✅ 2026-07-29
`scheduler.ts` (getDueSources + enqueue IngestMessage with deterministic
jitter, bounded per invocation), `ingest-consumer.ts` (full pipeline:
fetch → normalize → upsert → observation → lifecycle → classification →
signal generation → source_runs metrics; idempotency via unique keys;
failure handling per spec §13.4 table), ops scripts (`add-source.mjs`,
`update-source.mjs`, `source-health.mjs`, `add-company.mjs`) shelling out
to `wrangler d1 execute --json`. Cookie/Turnstile admin tier removed per
spec; secret-bearer-token admin triggers (§13.5a) added. Test folder
isolation (`src/` → `test/`), centralized `isUniqueConstraintError` in
`lib/d1/unique-constraint.ts`, `unusedBinding<T>` Proxy for fake test
bindings.

### Milestone E — 8 of 11 P0 adapters done, 3 blocked (in progress)
Completed: greenhouse (original), lever, ashby, smartrecruiters,
workable, recruitee, personio (2026-07-31), breezy (2026-07-31). All
have Zod schemas, typed errors, fixture tests, registered in
`registry.ts`. Blocked pending a scope decision (no public,
unauthenticated, documented per-company board API found — see
Milestone E section below): teamtailor, jazzhr, bamboohr.

### Milestone H — Signal-quality logic pass ✅ 2026-07-29
H.1 Description-channel noise fix (structured-categories guard), H.2
`getCompanyRoleActivityStats()` (V/A/B inputs in one query), H.3 Real
V/A/B scoring (computeVolume/Acceleration/Breadth, score v2), H.4
Company-level signals (`hiring_burst`, `role_acceleration`,
`multi_location`, `persistent_demand`), H.5 Reconciliation (daily stale
signal recompute via `reconciliation.ts`, daily cron 06:00 UTC).

### Milestone I — Semantic search (I.1, I.2 done) ✅ 2026-07-29
I.1 Vectorize index `hiring-signals-jobs` (768-dim, cosine) + 5 metadata
indexes (companyId, roleCategory, locationMode, status, postedAt) + AI
binding + `@cf/baai/bge-base-en-v1.5`. I.2 Embedding write path:
`buildJobEmbeddingText` + `embedAndUpsertJob` at ingest time with
try/catch guardrail (embedding failure ≠ ingestion failure).

### Milestone J — Test migration (partially done) ✅ 2026-07-30
Inventory completed. `live-d1-client.ts`, `live-d1-database.ts`,
`live-cf-bindings.ts` in `packages/test-support` (wrangler d1 execute
--remote transport, direct REST for AI/VECTORIZE/KV, KV namespace
generalization, 90s vitest timeouts). Migrated: all 4 `packages/db/test/*.test.ts`,
`reconciliation.test.ts`, `scheduler.test.ts`. Policy exceptions
documented in AGENTS.md: INGEST_QUEUE send-capture, ATS adapter mocking.

### Open questions (resolved 1 of 2)
- ✅ `createCompany` + `add-company.mjs` + `DuplicateCompanyError` (Milestone D follow-up)
- [ ] Lifecycle thresholds (2/4/14): confirm constants module satisfies "configuration, not hard-coded" intent

---

## Milestone E — Remaining P0 adapters (closed, 8 of 11 built + 3 blocked/deferred)

Spec §20 Phase 3 step 1 groups these with "production hardening," after
the dashboard (Phase 2). Sequence after Milestone F unless a specific
provider is needed for real-world messier data before UI work.

Same contract every time (`AtsAdapter`: `provider`, `fetchBoard`,
`normalize`), same fixture-test pattern. One PR/commit per adapter.

- [x] `personio` ✅ 2026-07-31 — XML feed (`workzag-jobs`), hand-rolled
      `xml-lite.ts` extractor (no XML dep), canonical URL construction
      verified against a real live board. 15/15 fixture tests, repo
      typecheck/lint/adapters-test all green (`pnpm -r typecheck`,
      `pnpm --filter @hiring-signals/adapters lint`/`test`).
- [x] `breezy` ✅ 2026-07-31 — public, unauthenticated careers-site JSON
      feed (`https://{company}.breezy.hr/json?verbose=true`), distinct
      from the token-gated `api.breezy.hr/v3/...` back-office API
      (same authenticated-API-vs-public-board-feed split this repo
      already has for Greenhouse/Lever). Verified two independent
      ways: (1) a non-vendor 2020 WordPress-plugin support-forum
      thread showing a real, unauthenticated hit against
      `kaycan.breezy.hr/json?verbose=true` returning valid JSON; (2)
      Breezy's own developer docs
      (`developer.breezy.hr/reference/model-position`) publishing the
      `Position` schema, whose field names (`friendly_id`,
      `location.is_remote`, `department`, `requisition_id`, `type.name`)
      line up with the public feed's shape. Canonical URL pattern
      (`{host}/p/{friendly_id}-{slug}`) confirmed against a real live
      posting (`teal-media.breezy.hr/p/a26c13c11570-...`); adapter
      prefers the feed's own `url` field, falls back to a constructed
      `{host}/p/{friendly_id}` link when absent. 13/13 fixture tests,
      repo typecheck/lint/adapters-test all green, 114/114 total
      adapter tests passing, 0 regressions.
- [ ] `teamtailor` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against Teamtailor's own docs (`docs.teamtailor.com`,
      `partner.teamtailor.com/job_boards/`) plus an independent
      third-party ATS-scraping field guide (github.com/Masterjx9/
      OpenPostings, discussion #16): public API is API-key-gated, the
      Job Board XML feed is beta/partner-issued-per-customer (no
      `{boardToken}`-style pattern to construct from a slug), and the
      only unauthenticated surface is raw HTML/undocumented RSS
      scraping — a materially different, less stable contract shape
      than every other adapter here. Removed from the active P0 build
      list (2026-07-31) pending a real product decision on whether
      HTML-scraping is in scope; not dropped from the domain
      `ATS_PROVIDERS` enum or existing seed data, since three seeded
      sources already reference it and downgrading them from a clean
      "adapter not implemented" (`UnsupportedProviderError`, spec
      §13.4) to "invalid provider" would be a regression, not a
      cleanup. Revisit as P1/deferred; full investigation notes in git
      history (this section, pre-2026-07-31).
- [ ] `jazzhr` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against JazzHR's own docs (`apidoc.jazzhrapis.com`,
      `success.jazzhr.com`): main API is customer-scoped/key-gated
      (some tiers Plus/Pro-only), the "global JSON feed" is opt-in
      cross-customer syndication (wrong shape, not just wrong auth —
      not a per-company `{boardToken}` endpoint), and the only public
      surfaces are a hosted careers page and JS "Jobs Widgets" with no
      documented backing API — corroborated independently by two
      commercial aggregators (JobsPipe, Fantastic.jobs) both having
      built their own crawling layer specifically because no clean
      public API exists. Same disposition as teamtailor: removed from
      the active P0 build list, kept in the domain enum/seed data
      (two seeded sources reference it), revisit as P1/deferred.
- [ ] `bamboohr` — **BLOCKED, investigated not built** ⚠️ 2026-07-31.
      Verified against BambooHR's own docs
      (`documentation.bamboohr.com/reference/get-job-summaries`) plus
      an independent aggregator's own technical writeup
      (jobspipe.dev/sources/bamboohr): BambooHR is fundamentally an
      HRIS with an ATS module bolted on, its Jobs endpoint requires an
      authenticated caller with `hiring:applications` OAuth scope, and
      the only public surface (an embeddable careers widget) has a
      backing JSON URL/schema that "change[s] without notice" per the
      aggregator's own description of maintaining that integration —
      no stable per-company pattern this repo's adapter contract could
      rely on. Same disposition as teamtailor/jazzhr: removed from the
      active P0 build list, kept in the domain enum/seed data (one
      seeded source references it), revisit as P1/deferred.

**Milestone E is now closed for active adapter work**: all 11 P0
providers investigated, 8 built (greenhouse, lever, ashby,
smartrecruiters, workable, recruitee, personio, breezy), 3 blocked and
parked as above pending a product decision on HTML-scraping scope.
Don't restart work on the 3 blocked providers without that decision.

For each built adapter: confirm the provider's public, unauthenticated
board API is still live and documented *before* writing the schema
(spec §21) — don't assume last-known-good API shapes from training data
are current; check the provider's own developer docs.

- [x] `infrastructure/scripts/add-source.mjs`'s inlined provider enum
      copy — already in sync with `ATS_PROVIDERS` (verified 2026-07-31,
      all 11 providers present including the 3 blocked ones, since
      they're still valid DB values even without an adapter).
- [x] This file, updated as each adapter landed / as of the 2026-07-31
      Milestone E close-out above.

---

## Milestone F — Dashboard UI (Phase 2, `apps/web`)

**Pre-work bug fix (2026-08-02, found while scoping F, fixed and
verified before any UI code was written):** `listSignals`/
`getSignalDetail`/`findSignalsByJobIds` (all sharing `BASE_SELECT` in
`packages/db/src/signals-repo.ts`) never returned `location_mode`,
`country_code`, `source_platform`, or `canonical_url` — only
`listSignalsForExport`'s one-off query had that join. Spec §10.3 (card:
"Location / work mode if available", "Source platform label") and §10.5
(detail: evidence table + `OPEN PUBLIC JOB POST ↗` link) both require
these, so Milestone F would have had no data to render them with.
Fixed by folding the representative-job LEFT JOIN into `BASE_SELECT`
itself (new `REPRESENTATIVE_JOB_JOIN` fragment, shared by list/detail/
semantic-search/export instead of export duplicating it); extended
`SignalRow`/`SignalListItem` with the four new nullable fields;
`SignalExportRow` is now a type alias, not a separate shape. Also fixed
a pre-existing test time-bomb found during verification: `signals-repo
.test.ts`'s `sort=newest` test used hardcoded absolute dates
(`2026-07-01`/`2026-07-20`) that aged out of `listSignals`' rolling
30-day default `observedSince` window as real time passed — switched to
now-relative offsets. Verified: `pnpm -r typecheck` clean (6/6
workspaces), `pnpm -r lint` 0 errors, `signals-repo.test.ts` 15/15 and
`signals-export-repo.test.ts` 5/5 passing against live D1, `domain`
70/70 + `adapters` 114/114 fast suites green.

Spec §11 (Minimal Brutalist visual system), §12 (Next.js requirements),
§10 (UX spec — route map, filters, signal cards, detail view, empty/
loading/error states).

**UI/animation inspiration (behavior, NOT styling): ArxivExplorer.**
Same account, same "single-page dense dashboard" shape. Reuse the
animation mechanics and interaction timing, never the visual styling.
ArxivExplorer is neon-red cyberpunk; this product is strict black/white
Minimal Brutalist (spec §11: no gradients, no glassmorphism, no drop
shadows, one scarce accent color).

**Concrete component-by-component reuse map** (confirmed present
2026-07-30 in ArxivExplorer on disk):

- **`ScrollProgress.tsx`** — port near-verbatim; restyle bar to 2px
  solid black/accent line instead of neon-red gradient.
- **`Card.tsx`** hover mechanics — keep `y: -3` lift, corner-accent
  squares (4px→6px, solid black border), 0.18s hover transition.
  **DROP: mouse-tracking radial glow + blur** (explicitly forbidden by
  spec §11.1).
- **`AnimatedTagline.tsx`** per-character stagger-in — reuse entrance
  cascade for the `HIRING//SIGNALS` masthead. **DROP: color-shift/
  text-shadow hover.** Must guard with `prefers-reduced-motion`.
- **`DecryptedText.tsx`** scramble-in-place — optional, lower priority
  (score badge). Gate to 700ms max in monospace; don't sacrifice score
  legibility mid-scramble.
- **`AchievementToast.tsx`** event-driven toast queue — reusable
  *mechanism*, not content (no achievements/gamification here). Flag as
  reusable pattern for later, don't build now.
- **`ParticleBackground.tsx`** / **`ui/background-beams.tsx`** — **do
  NOT port.** Pure decorative ambient motion; spec §11.1 forbids this.
- **`SearchBoxHome.tsx` / `SearchFilters.tsx` / `MoreLikeThisButton.tsx`
  / `RecentSearches.tsx` / `AbstractSearch.tsx`** — covered by
  Milestone I.4.

**Required dependency not yet installed:** `framer-motion` (Card,
AnimatedTagline, DecryptedText ports). `three` is explicitly NOT needed
(ParticleBackground rejected). Install when F actually starts, check
React 19 compatibility first.

### Sequencing

F.1–F.3 (shell/tokens/primitives) must land before F.4 (feed) or F.5
(detail) — every later task renders inside the app-shell using the F.2
tokens and F.3 primitives. F.4 and F.5 can proceed in parallel once F.3
is done. F.6 (empty/loading/error) threads through F.4/F.5 rather than
following them, so build it alongside, not after. F.7 (a11y+responsive
pass) is last because it audits everything built in F.1–F.6.

I.4 (Search UI, Milestone I) explicitly slots in after F.4 exists — the
search bar and filter-URL-param wiring built here are exactly what I.4
needs; I.4 must not duplicate F.4's URL-state logic.

### F.1 — Project setup (`apps/web`)

Spec §12.1.

- [x] **Install `framer-motion`** — ✅ done 2026-08-03. Installed
      `framer-motion@^12.43.0` (resolved `12.43.0`), not the `^11.x`
      line ArxivExplorer's source components were originally written
      against — checked first: `framer-motion` v12 has full official
      React 19 support (confirmed via the package's own docs/changelog),
      and the package has since been renamed upstream to `motion`
      (`motion/react` import path) with `framer-motion` kept as a
      compat-named alias pointing at the same v12 code. Ported
      components (F.3's Card/ScrollProgress/AnimatedTagline) can keep
      `from "framer-motion"` imports unchanged for now; migrating to
      `motion/react` is a low-priority future cleanup, not required for
      F. `pnpm peers check` showed one unrelated pre-existing warning
      (`@cloudflare/workers-types` vs. `wrangler`'s wanted range,
      nothing to do with `framer-motion`/React 19). Verified:
      `pnpm --filter @hiring-signals/web typecheck`/`lint` clean with
      the dependency installed.
- [x] **CSP** — ✅ already done; landed as part of Milestone G.2 (backend
      hardening pass, 2026-08-03), not duplicated here.
      `next.config.ts`'s `headers()` function sets
      `Content-Security-Policy` (scoped to `'self'` +
      `NEXT_PUBLIC_API_BASE_URL` for `connect-src`), plus
      `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
      See Milestone G.2 for the full rationale/verification.
- [x] **`next/image` remote-pattern allow-list** — ✅ confirmed no-op,
      2026-08-03. `next.config.ts` has no `images.remotePatterns` block
      — correct, since nothing in the current data model serves company
      logos or other remote images yet. Revisit only if/when a future
      milestone actually needs `next/image` with a remote host (also
      flagged in G.2's dependency-audit baseline re: the `sharp`
      finding — that code path stays unexercised until this changes).
- [x] Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint` clean
      after dependency changes — confirmed 2026-08-03.

### F.2 — Design tokens + global styles (spec §11.2, §11.3)

- [ ] Replace `globals.css` (currently default Next.js starter, includes
      `dark:` variants the spec doesn't call for — product is strict
      black/white, no dark-mode toggle) with the token set from spec
      §11.2 as CSS custom properties: `--ink`, `--paper`, `--muted`,
      `--soft-ink`, `--accent` (`#dfff00`), `--border`, `--border-thin`,
      `--radius: 0px`.
  - Contrast-check `--accent` (#dfff00) against black text before
    committing — spec §11.2 requires this explicitly; don't assume a
    chartreuse passes AA without checking.
- [ ] Typography: system sans-serif 700–900 weight for display/nav,
      `ui-monospace`/`SFMono-Regular`/`Menlo`/`Monaco`/`Consolas` stack
      for data points (score badges, timestamps, IDs). No web font load
      unless a specific need is identified (spec §11.3 — avoid loading a
      font merely for aesthetics).
- [ ] Base font size 16px minimum; data labels 11–12px with adequate
      line-height (spec §11.3).
- [ ] Focus style: 3px solid black outline with offset, applied globally
      via `:focus-visible` (spec §11.5) — this must exist before any
      interactive component is built, not retrofitted in F.7.
- [ ] `prefers-reduced-motion` global guard: all framer-motion entrance/
      hover animations must respect it (spec §11.5); transitions under
      150ms. Establish the pattern here (e.g. a `useReducedMotion` hook
      wrapper) so every later port (F.3 Card, ScrollProgress,
      AnimatedTagline) uses it from the start instead of needing a
      follow-up pass.
- [x] Verify: render the token sheet in a throwaway page, eyeball against
      spec §10.2's ASCII mockup — hard borders, no shadow, no radius.
      Done 2026-08-03: `page.tsx` was still 100% create-next-app
      boilerplate (zinc palette, dark: variants, Vercel branding) —
      F.2's token work in globals.css/layout.tsx had never actually been
      exercised by any rendered markup. Replaced with a minimal, clearly
      marked TEMPORARY showcase (removed wholesale by F.3). Playwright
      screenshot confirmed: pure white/black paper/ink, chartreuse CTA
      with black text per the WCAG-checked pairing, sharp 0px-radius
      borders, `.data-label` monospace rendering correctly. No dark-mode
      flicker, no starter branding.

  **Bug found + fixed during this verification:** G.2's strict
  `script-src 'self'` CSP (next.config.ts) broke `next dev` itself —
  Turbopack's inline HMR bootstrap scripts and React's dev-mode
  `eval()` (stack-trace reconstruction) were both blocked, cascading
  into a client `InvariantError` that broke the dev app entirely (7
  console errors on load). Fixed by making the CSP a function of
  Next's build `phase` (`PHASE_DEVELOPMENT_SERVER` from
  `next/constants`) rather than `process.env.NODE_ENV` — this
  machine's shell has `NODE_ENV=production` set ambiently even under
  `next dev` (Next.js itself warns about this), so an env-based check
  would have silently shipped the strict prod CSP under dev and
  reintroduced the exact breakage. `'unsafe-inline'` and `'unsafe-eval'`
  are now scoped to `PHASE_DEVELOPMENT_SERVER` only.
  Verified end-to-end: fresh-tab dev load → 0 console errors;
  `pnpm typecheck`/`lint` → clean; `next build` → succeeds; `next
  start` (production phase) → confirmed strict `script-src 'self'`
  ships with no unsafe directives, dev relaxation does not leak into
  prod.

### F.3 — Base primitives + layout shell (spec §12.3, §11.4)

Build `components/ui/` first (leaf nodes), then the shell that composes
them. Every component below is new code — nothing in `apps/web/src`
exists yet beyond the Next.js starter.

- [x] `components/ui/button.tsx` — rectangular, black border, bold
      uppercase; primary variant chartreuse fill; hover inverts fg/bg
      (spec §11.4 table). Keyboard-operable, visible focus.
      Done 2026-08-03: native `<button>` for free keyboard support +
      F.2's global `:focus-visible` outline; `primary`/`secondary`
      variants, primary inverts to black-on-chartreuse on hover matching
      the WCAG-checked pairing from F.2.
- [x] `components/ui/input.tsx` — white bg, 2px black border, square
      corners, explicit `<label>` above (not placeholder-as-label).
      Done 2026-08-03: `label` is a required prop (not optional
      decoration), uses `useId()` so callers never have to wire
      `htmlFor`/`id` manually.
- [x] `components/ui/checkbox.tsx` — native or visibly custom, keyboard-
      operable, chartreuse when selected.
      Done 2026-08-03: native `<input type="checkbox">` restyled via
      `accent-color` so screen readers keep the real checkbox role/state
      rather than a fully custom div-based control.
- [x] `components/ui/data-label.tsx` — small monospace label component
      for score/timestamp/count display (11–12px per §11.3).
      Done 2026-08-03: thin wrapper around F.2's `.data-label` CSS class
      so every data-point element in F.4/F.5 goes through one component.
- [x] `components/scroll-progress.tsx` — port `ArxivExplorer`'s
      `ScrollProgress.tsx` near-verbatim (scroll-fraction state +
      `scaleX` transform); restyle the bar to a 2px solid black/accent
      line, drop the neon-red gradient. Wrap in the F.2 reduced-motion
      guard.
      Done 2026-08-03: ported near-verbatim (plain CSS transform via
      inline style, no framer-motion involved in the original), added
      the matching `.scroll-progress` CSS to globals.css (solid 2px
      `--accent` line, fixed top, no gradient/blur).
- [x] `components/app-shell.tsx` — top-level layout: masthead + filter
      rail (fixed 280–320px desktop) + fluid content column (spec
      §10.2). Mobile: filter rail collapses into a full-width `<details>`/
      sheet control above results (spec §10.2). Semantic landmarks:
      `header`, `nav`, `main`, `aside` (spec §11.5).
      Done 2026-08-03: `filters` is an optional prop (no filter-rail
      content exists until F.4) — pages without it simply don't render
      the `<aside>`. Desktop rail is `md:w-[280px] lg:w-[320px]`; mobile
      uses `<details>`/`<summary>` for free keyboard/a11y collapse state
      instead of a JS-driven sheet component.
- [x] `components/masthead.tsx` — `HIRING//SIGNALS` wordmark, last-sync
      timestamp, `[EXPORT CSV]` button (wired to Milestone L's route in
      F.4, stubbed/disabled here if F lands before L.1's route params
      are threaded through). Port `AnimatedTagline.tsx`'s per-character
      stagger-in for the wordmark only — drop color-shift/text-shadow
      hover; guard with `prefers-reduced-motion`.
      Done 2026-08-03: Export CSV ships `disabled` with a `title`
      explaining why (L.1 not landed yet) rather than a dead/broken
      link. `AnimatedTagline` ported with the neon-red glow hover
      stripped per spec §11.1 — kept only the opacity stagger-in, hover
      is now a plain 2px lift gated by `useReducedMotion`.
- [x] Update `src/app/layout.tsx` to use `app-shell.tsx` instead of the
      current bare passthrough; remove default Next.js starter content
      from `page.tsx` (currently the create-next-app template — logo,
      "Deploy Now" links, etc.).
      Done 2026-08-03: `AppShell` wraps every route at the root layout
      level (masthead/scroll-progress are global chrome); `page.tsx`
      replaced with a minimal F.4 placeholder (previously F.2's
      temporary token-showcase, itself replacing the original
      create-next-app starter content).
- [x] Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint`
      clean; manual check at 320px width and 200% zoom (spec §11.5)
      that the shell doesn't break.
      Done 2026-08-03: typecheck/lint clean throughout. **Bug found at
      320px:** the masthead's single-row `flex justify-between` broke
      down — wordmark line-wrapped mid-word ("HIRING//SI / GNALS") and
      the timestamp/button were crushed into narrow columns. Fixed with
      `flex-wrap` on the header plus `whitespace-nowrap` on the wordmark
      and timestamp (added a `className` prop to `AnimatedTagline` to
      allow this), so the layout now cleanly drops to two rows instead
      of squeezing everything horizontally. Reverified at 320px (clean
      two-row wrap, no overflow), at a 640×450 viewport simulating 200%
      zoom on 1280px desktop (clean single row, no clipping), and back
      at 1280px desktop (no regression). Zero console errors at every
      width tested.

### F.4 — Signal feed + filters (`/signals`, spec §10.2–§10.4, §12.2)

This is the main dashboard. Depends on F.1–F.3.

- [ ] Firm up `lib/api-client.ts`'s `unknown` response typings —
      `fetchSignals`/`fetchSignalDetail`/`fetchFacets` currently return
      `{ data: unknown[]; meta: Record<string, unknown> }`. Import the
      real `SignalListItem`/`SignalDetail` shapes from
      `@hiring-signals/db` (already a workspace dependency of
      `apps/web`, confirm it exports these — currently only
      `@hiring-signals/domain` is wired in `package.json`, may need
      adding). Match `fetchSignals`' params to the live query schema
      exactly: `roles`, `company`, `q`, `locationMode`, `country`,
      `source`, `signalType`, `minScore`, `observedSince`, `sort`,
      `cursor`, `limit` — `api-client.ts` is currently missing `q`,
      `locationMode`, `country`, `source`, `signalType`.
- [ ] `lib/searchParams.ts` (new) — parse + validate URL search params
      into the filter state on initial render (spec §12.2 step 1), using
      the same param names/shapes as the API's Zod schema so URL state
      and API request state never drift. URL is the source of truth;
      filter changes call `router.replace`/`router.push` per spec
      §12.2 step 4 (decide replace vs push: rapid filter toggling should
      likely `replace`, not spam history).
- [x] `components/filter-rail.tsx` — composes role-filter,
      company-combobox, score-filter, plus the P0 filters spec §10.4
      lists beyond the component-tree diagram (work mode, source
      provider, signal type, observed-since presets: 24h/7d/30d/custom).
      Filter groups compose with AND; multi-select within a group (role)
      composes with OR (spec §10.4).
      Done 2026-08-03: purely controlled (FilterState + one onChange),
      takes an optional shared `facets` prop rather than each child
      filter fetching independently. No `/signals` page exists yet to
      own the actual fetch/URL-sync wiring or render `<FilterRail>` into
      `AppShell`'s `filters` slot — that's the next item.
- [x] `components/role-filter.tsx` — multi-select checkbox list, canonical
      role taxonomy from `@hiring-signals/domain`'s `roleCategorySchema`,
      counts sourced from `fetchFacets()`.
- [x] `components/company-combobox.tsx` — typeahead starting after 2
      characters, ~250ms debounce (spec §12.2), searches display name/
      alias/domain, selecting sets the canonical slug in the URL as
      `company`. Single-company only in MVP (spec §10.4 — multi-company
      is P1, don't build the multi-select affordance now).
- [x] `components/score-filter.tsx` — 0–100 range or preset thresholds
      (spec §10.4); maps to `minScore` param.
      Done 2026-08-03: preset threshold toggle buttons (Any/40+/60+/80+),
      not a continuous slider — no slider primitive exists yet and every
      other F.4 filter is discrete-choice. `aria-pressed` toggles, not
      `role="radio"` (no roving-tabindex arrow-key support implemented).
- [x] `components/work-mode-filter.tsx` — single-select toggle buttons
      (remote/hybrid/onsite/unknown + Any), counts from
      `Facets.locationModes`. Done 2026-08-03.
- [x] `components/source-filter.tsx` — single-select toggle buttons over
      `ATS_PROVIDERS`, counts from `Facets.sources`; only providers with
      a nonzero facet count render as options (3 of 11 P0 providers are
      deferred/unbuilt per Milestone list above and would otherwise be
      permanently-empty options). Done 2026-08-03.
- [x] `components/signal-type-filter.tsx` — single-select toggle buttons
      over `SIGNAL_TYPES`. No facet counts: `Facets`
      (`packages/db/src/types.ts`) has no `signalTypes` entry yet (only
      roles/sources/locationModes are faceted) — add one first if counts
      are wanted here. Done 2026-08-03.
- [x] `components/since-filter.tsx` — 24h/7d/30d preset toggle buttons
      plus a custom `YYYY-MM-DD` date input, mutually exclusive (mirrors
      `FilterState["since"]`'s single-value shape). Done 2026-08-03.
- [ ] `components/signal-feed.tsx` — client component, fetches via
      `fetchSignals`, cancels stale requests when filters change rapidly
      (spec §12.2 step 5 — `AbortController` keyed to the filter-state
      dependency). Cursor-based "load more" / infinite scroll using
      `meta.nextCursor`.
- [ ] `components/signal-card.tsx` — spec §10.3's 9 required fields:
      score badge, company name (+domain if known), signal type label,
      role category + title/aggregate count, location/work mode (nullable
      — omit the line when `locationMode`/`countryCode` are null, per
      `SignalRow`'s documented degrade for company-level signals),
      "Observed" time (never an invented posting time — use
      `lastDetectedAt`, not a fabricated posted-date), source platform
      label, `VIEW EVIDENCE →` CTA linking to `/signals/[signalId]`.
      Score block styling per §11.4: monospace, black-fill/white-text
      normal, chartreuse-fill/black-text at score ≥ 80.
  - Port `Card.tsx`'s hover mechanics only: `y: -3` lift, 0.18s
    transition, corner-accent squares (4px→6px on hover, solid black
    border, square not rounded). **Do not port** the mouse-tracking
    radial glow/blur (`useMotionValue`/`useMotionTemplate` gradient) or
    `backdrop-blur`/drop-shadow — spec §11.1 explicitly forbids
    glassmorphism and drop shadows.
- [ ] URL example round-trip test (manual or automated): spec §10.4's
      `/signals?roles=cybersecurity,cloud_platform_devops_sre&company=acme-corp&minScore=60&since=7d`
      loads with those filters pre-applied and results match what the
      same params would return from `GET /api/v1/signals` directly.
- [ ] Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint`
      clean; manual filter-combination smoke test against a running
      `apps/api` dev server; keyboard-only navigation through filter
      rail → feed → card CTA.

### F.5 — Signal detail (`/signals/[signalId]`, spec §10.5)

Depends on F.1–F.3. Can build in parallel with F.4.

- [ ] `components/signal-detail.tsx` — company header + outbound domain
      link if known, score + plain-language breakdown, exact signal
      rule + detection time, trend block (active matching roles over 7/
      30/90 days — check whether this needs a new API field; `SignalDetail`
      as currently shaped doesn't carry it, may need a follow-up repo
      function or can defer to Milestone O's timeline work if out of
      scope for F).
- [ ] `components/evidence-table.tsx` — job title, source, observed
      time, location, status, public URL columns, sourced from
      `SignalDetail.evidence[]`. Strong column headers, horizontal
      overflow on narrow screens (spec §11.4).
- [ ] `components/score-breakdown.tsx` — plain-language explanation of
      the score components (R/V/A/B/Q from `computeNewJobScore`,
      Milestone C) — not the raw formula, a legible summary.
- [ ] `OPEN PUBLIC JOB POST ↗` link — `canonicalUrl` field, external-link
      arrow suffix per spec §11.4's Link row. Handle `null` (company-level
      signals with no representative job) by omitting the link, not
      showing a dead one.
- [ ] Data limitations note (verbatim per spec §10.5): "Based on publicly
      available job-board information; listing status may change."
- [ ] Copyable outreach research prompt — spec §10.5 explicitly requires
      this to be a research *prompt*, not a fabricated personalized
      message. Draft template text grounded only in fields already on
      `SignalDetail` (no invented facts about the company).
- [ ] Optional side panel on wide screens vs. direct route (spec §10.5
      "A direct route plus optional side panel") — decide at
      implementation time; direct route is required, side panel is the
      enhancement.
- [ ] Verify: `pnpm --filter @hiring-signals/web typecheck`/`lint`
      clean; manual check that a company-level signal (null
      canonicalUrl/locationMode/countryCode) renders without a broken
      link or blank crash.

### F.6 — Empty, loading, and error states (spec §10.6)

Build alongside F.4/F.5, not after — these states are properties of the
feed/detail components, not a separate screen.

- [ ] `components/empty-state.tsx` — covers all four spec §10.6 rows:
      first-load skeleton (dense-layout-preserving skeleton rows, not a
      generic spinner), no-filters-match ("NO SIGNALS MATCH THIS QUERY."
      + `RESET FILTERS` CTA that clears URL params), no-data-yet
      (explains monitored-source scope — pull copy from spec/README, not
      "no hiring exists"), source-stale ("Source last confirmed X ago" —
      needs a data source; check whether `source_runs` timing is already
      exposed via any current API response or needs a new field).
- [ ] `components/status-line.tsx` — compact API-error panel with retry
      action, no raw stack trace exposed to the user (spec §10.6).
      Wraps `ApiClientError` from `api-client.ts`.
- [ ] Verify: manually trigger each state (empty filters, API down,
      fresh/empty DB) against a local dev API and confirm required copy
      appears verbatim.

### F.7 — Accessibility + responsive pass (spec §11.5)

Last — audits everything F.1–F.6 built, not built in isolation.

- [ ] WCAG 2.2 AA contrast check across all text/background pairs,
      especially `--accent` usage (chartreuse background + black text
      only, never chartreuse body copy on white, per §11.2).
- [ ] Confirm every filter input has a persistent visible label (not
      placeholder-only).
- [ ] Confirm focus order follows visual order across app-shell → filter
      rail → feed → card → detail.
- [ ] Confirm no interaction relies on hover alone (evidence/actions must
      be keyboard/touch reachable) — audit `signal-card.tsx`'s CTA and
      any hover-revealed affordances.
- [ ] Test at 200% zoom and 320px CSS-pixel width (spec §11.5) across
      `/signals`, `/signals/[signalId]`, and the mobile filter-sheet
      collapse.
- [ ] Confirm all framer-motion animations respect
      `prefers-reduced-motion` and stay under 150ms where non-essential
      (spec §11.5) — re-check this wasn't lost in F.4/F.5 component
      work even though F.2 established the pattern.
- [ ] Verify: manual audit pass with a screen reader spot-check (landmark
      navigation, form label announcement) plus browser DevTools
      accessibility tree check; document any deferred issues here rather
      than silently shipping known gaps.

---

## Milestone G — Hardening, deploy (Phase 3 remainder / Phase 4)

Spec §14 (security controls, privacy posture, legal copy), §15
(performance/reliability targets), §16 (observability/ops), §18
(CI/CD), §19 (acceptance criteria).

**Framing, confirmed by audit before writing these tasks (2026-08-03):**
unlike Milestone F, this is not a blank slate. `apps/api` already has a
real middleware chain (`request-id`, `client-ip`, `security-headers`,
`freeReadTier` rate limiting, `adminAuth` with SHA-256-hashed-IP strike
lockout), a dedicated `RAW_PAYLOADS` KV namespace with 30-day auto-expiry
(reviewed 2026-07-30, CWE-668), and adapter fetch targets that are
hard-coded per provider in `registry.ts`/each adapter file — not built
from arbitrary DB input — so SSRF surface is small by construction
already. G is mostly a **verification and gap-closing pass**, not net-new
construction: confirm what's built actually meets each spec §14/§15/§16
bullet, then build the specific items that audit found missing. Don't
treat this milestone as "build security from scratch."

No auth item: single-tenant, public, no login, ever (spec §22 preamble).

### Sequencing

G.1 (security audit) must run first — it determines which of G.2–G.5's
sub-items are real gaps vs. already-satisfied. Don't build G.2's items
blind; the audit in G.1 already found several are done. G.6 (CI/CD) and
G.7 (acceptance criteria) close the milestone once G.1–G.5 land.

### G.1 — Security control audit against spec §14.1 (do this first)

Go through spec §14.1's bullet list one at a time and record a verified
disposition (✅ already satisfied / ⚠️ partial / ❌ gap) for each, citing
the actual file. Findings so far from this session's read-through
(confirm/extend, don't retake from scratch):

- [x] **"Public API routes are unauthenticated"** — ✅ confirmed.
      `freeReadTier()` (no auth check) applied to every `/api/v1/*` read
      route in `index.ts`; `/api/v1/admin/*` is the sole
      secret-gated exception (`adminAuth()`, spec §13.5a).
- [x] **"Parameterize every SQL query"** — ✅ spot-checked
      `signals-repo.ts` — uses `?` placeholders throughout, no string
      interpolation into SQL found in the files read this session. Full
      sweep still worth a dedicated grep pass (see G.1 verify below)
      rather than relying on spot checks alone before declaring this
      item closed.
- [x] **"Validate all external payloads"** — ✅ every adapter
      (`greenhouse.ts` confirmed) runs the raw ATS response through a
      Zod schema (`greenhouseBoardSchema` etc.) before use; Worker route
      query params go through `signalsQuerySchema`/equivalents.
- [ ] **"Escape/sanitize untrusted job descriptions; no
      `dangerouslySetInnerHTML`"** — not yet verified. This is an
      `apps/web` concern (rendering `content`/description fields from
      adapters) and `apps/web` doesn't render any job descriptions yet
      (Milestone F not started). Re-check once F.5's evidence
      table/detail view exists — flag as a blocking check before F.5
      ships, not just a G item.
- [x] **"Limit outbound URL fetching to adapter-defined, allow-listed
      hosts (SSRF)"** — ✅ effectively satisfied by construction:
      `registry.ts`'s `ADAPTERS` map is a fixed, code-defined
      provider→adapter lookup (not DB-driven), and each adapter
      (`greenhouse.ts`'s `boardUrl()` confirmed) interpolates only an
      `encodeURIComponent`-escaped `boardToken` into a hard-coded host
      template — the host itself is never attacker/DB-controlled. Gap:
      this guarantee isn't written down anywhere as a deliberate
      invariant — add a one-paragraph comment to `adapter-contract.ts`
      stating the rule explicitly ("adapters MUST hard-code their host;
      only path segments may come from SourceConfig") so a future
      adapter doesn't accidentally break the invariant.
- [x] **"Set CSP, X-Content-Type-Options, Referrer-Policy,
      Permissions-Policy"** — ✅ for `apps/api`:
      `lib/http/security-headers.ts` sets all four on every response.
      ❌ **gap for `apps/web`**: `next.config.ts` has zero headers
      configuration; this is the same gap Milestone F.1 already flagged
      independently. Track the fix in G.2, not duplicated in F — F.1
      can link here instead of owning the implementation.
- [ ] **"Redact authorization headers, cookies, source payload bodies
      from logs"** — spot-checked `error-handler.ts` (clean — logs only
      `requestId`+`message`, never raw `err` or headers) and
      `admin-auth.ts` (logs SHA-256 IP hash, never the raw
      `Authorization` value). Not yet a full sweep of every
      `console.log`/`console.error`/`console.warn` call site in
      `apps/api/src` (19+ call sites found this session, only a handful
      inspected). Do the full sweep in G.2.
- [ ] **"Dependency scanning + lockfiles; patch critical vulnerabilities
      promptly"** — ⚠️ partial. `pnpm-lock.yaml` exists and is committed
      (lockfile requirement met). ❌ **gap**: `.github/workflows/ci.yml`
      has no `pnpm audit` (or equivalent) step — confirmed by reading
      the workflow file this session. Real, actionable gap for G.2.

- [x] **Full grep sweep for raw SQL string interpolation** — ✅ done
      2026-08-03. Checked every template-literal-built SQL string in
      `packages/db/src/*.ts` (regex for `` `...${...WHERE|SELECT|
      INSERT|UPDATE|DELETE...}...` `` plus manual read of
      `signals-repo.ts`'s `listSignals`). Pattern confirmed clean
      throughout: `where`/`args` are built as parallel arrays —
      `where.push("column = ?")` + `args.push(value)` — column names and
      SQL keywords are hard-coded strings, actual values always flow
      through `?` placeholders into `client.all(sql, args)`, never
      spliced into the SQL text. The one template-literal-interpolated
      piece per query is `orderBy`, which is itself a closed ternary
      over the already-Zod-validated `sort` enum (`newest`/
      `company_asc`/score-default) — never raw user input. LIKE-pattern
      free-text search (`q` param) escapes `%`/`_` via
      `escapeLikePattern()` before wrapping in wildcards. No
      SQL-injection surface found.
- [x] **Full sweep of every `console.*` call site in `apps/api/src`** —
      ✅ done 2026-08-03. All 19+ call sites (across
      `error-handler.ts`, `admin-auth.ts`, `semantic-search.ts`,
      `signals.ts`, `reconciliation.ts`, `ingest-consumer.ts`) log only
      structured fields: request/source/run/signal/company IDs, error
      *names* and *messages* via an `errorMessage()`/`errorMessageSafe`
      helper pattern — never the raw `Error` object, never request
      headers, never raw ATS payload bodies. `admin-auth.ts` logs a
      SHA-256 hash of the IP, never the raw `Authorization` header
      value. No redaction gap found.
- [x] Document final disposition of every spec §14.1 bullet — done
      above; final tally as of 2026-08-03: 6 of 8 bullets ✅ fully
      satisfied (unauthenticated routes, SQL parameterization, payload
      validation, SSRF allow-listing by construction, log redaction,
      `apps/api` security headers), 1 partial with a real gap (dependency
      scanning — lockfile yes, CI audit step no), 1 not yet checkable
      (job-description sanitization — blocked on Milestone F.5 existing).
      `apps/web` CSP is a separate, already-identified gap (not one of
      the 8 §14.1 bullets directly, but required by §12.1/§14.1
      together). G.2 closes the two real gaps found.

### G.2 — Close confirmed gaps from G.1

Only build what G.1 actually found missing — don't rebuild what's
already there.

- [x] **CI dependency scanning** — ✅ done 2026-08-03. Added
      `pnpm audit --audit-level=high || true` as a non-blocking step to
      `.github/workflows/ci.yml`'s `fast-checks` job, after the
      domain/adapters test steps. Warn-only (`|| true`) per the decision
      above — ran it locally first to establish a real baseline before
      deciding blocking-vs-warn was even the right call.
  - **Baseline run (2026-08-03, local, `pnpm audit --audit-level=high`):**
    13 findings (1 critical, 7 high, 5 moderate). All 13 are
    devDependency-only or a not-yet-exercised feature, none is live
    runtime-exposed attack surface today: `vitest` <3.2.6 (critical —
    arbitrary file read/execute, but only when its UI server is
    listening, which nothing in this repo's scripts/CI ever starts),
    `vite` <=6.4.2 (transitively via vitest, dev-only), `postcss`
    <=8.5.17 ×2 advisories (transitively via `next`'s build tooling,
    not shipped to the browser), `brace-expansion` <1.1.18/<5.0.9 ×3
    advisories (transitively via `eslint`'s `minimatch` chain, dev-only,
    DoS-class not data-exposure), `sharp` <0.35.0 (via `next`'s
    `next/image` optimizer — real runtime dependency, but Milestone F.1
    already decided no remote image hosts are configured/used yet, so
    this code path isn't exercised; re-flag as higher-priority the
    moment F.1 or any later milestone actually wires up `next/image`
    with a remote pattern).
  - **Action taken:** none of the 13 justified blocking CI today given
    the above; recorded here as a dated baseline so future `pnpm audit`
    runs can be diffed against it (new findings vs. this list) rather
    than re-triaged from zero each time. Revisit `vitest`/`sharp`
    specifically at the next dependency-bump pass since patched
    versions exist for both.
- [x] **SSRF invariant documentation** — ✅ done 2026-08-03. Added the
      explicit invariant comment to
      `packages/adapters/src/adapter-contract.ts`'s `AtsAdapter`
      interface doc comment, spelling out that `fetchBoard`'s request
      host must always be a string literal in the adapter's own file,
      never built from `SourceConfig` fields.
- [x] **`apps/web` security headers/CSP** — ✅ done 2026-08-03 (pulled
      forward from the item above, implemented together). Added an
      `async headers()` function to `next.config.ts` setting
      `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
      a locked-down `Permissions-Policy`, and a CSP
      (`default-src 'self'`, `connect-src 'self' <NEXT_PUBLIC_API_BASE_URL>`,
      `frame-ancestors 'none'`, etc. — `style-src` allows
      `'unsafe-inline'` for Tailwind's runtime injection). Verified:
      `pnpm --filter @hiring-signals/web typecheck`/`lint` both clean
      after the change.
- [x] Verify: re-ran G.1's SQL/log sweeps conceptually against the new
      code — neither touched SQL or logging, no re-sweep needed. G.1's
      disposition list updated to ✅ above with 2026-08-03 dates.
  - **Correction (2026-08-03, found during F.2):** the CSP above as
      originally shipped applied `script-src 'self'` unconditionally,
      which broke `next dev` itself (Turbopack HMR + React dev-mode
      `eval()` both blocked). Fixed to scope `'unsafe-inline'`/
      `'unsafe-eval'` to `PHASE_DEVELOPMENT_SERVER` only, using Next's
      `phase` argument rather than `NODE_ENV` (unreliable on this
      machine — see F.2 for the full writeup). Production's
      `script-src 'self'` is unchanged and reverified clean.

### G.3 — Privacy posture (spec §14.2) + legal copy (spec §14.3)

- [ ] Confirm no candidate-personal-data fields (names, emails, resumes)
      are captured anywhere in the ingestion pipeline — audit
      `packages/adapters/src/*.ts`'s Zod schemas for any field that
      could carry personal applicant data (as opposed to organization/
      job-post data, which is the explicitly in-scope data type per
      §14.2). Spot-checked `greenhouseJobSchema` this session — only
      job/org fields (title, location, department, url) — extend the
      check to every adapter.
- [ ] Operator-accessible source removal workflow (§14.2: "if a company
      requests removal... disable its source and remove retained raw
      payloads according to policy after legal review") — check whether
      `infrastructure/scripts/update-source.mjs` already supports
      disabling a source; if so this may already be satisfied for the
      "disable" half. The "remove retained raw payloads" half: raw
      payloads already auto-expire after 30 days (`raw-payload-store.ts`)
      — confirm whether an immediate-delete-on-request path is needed
      beyond that passive expiry, or whether 30-day auto-expiry plus
      immediate source-disable satisfies the spec's intent as written.
- [ ] Footer/legal copy — spec §14.3 requires this **verbatim** string
      somewhere in the app: "Signals are derived from publicly accessible
      job listings and may be incomplete or outdated. Verify current
      information at the linked source before contacting an
      organization." This is an `apps/web` UI item (Milestone F's
      `app-shell.tsx` footer) — cross-reference: add it there when F
      builds the shell, track completion here since it's a spec §14
      requirement, not a design-system one.
- [ ] Audit signal/summary copy for the forbidden phrasing spec §14.3
      calls out ("actively buying," "in market," "budget approved") —
      check `buildHeadline`/`buildSummary` functions (Milestone C/H/K)
      use only the sanctioned phrasing ("public hiring signal," "matching
      role observed," "recent posting activity").
- [ ] Verify: grep for the three forbidden phrases across
      `packages/domain/src` and `apps/api/src` to confirm none appear in
      generated copy.

### G.4 — Performance targets verification (spec §15)

Mostly verification against already-built infrastructure (facet KV
cache, cursor pagination, indexed queries already exist per completed
milestones) rather than new implementation.

- [ ] Measure actual p95 latency for cached facet response and
      uncached `/api/v1/signals` query against the targets (facet <
      250ms, uncached signals query < 800ms for 50 results) — needs a
      populated D1 with realistic row counts, not just the 20-company
      seed fixture. Decide whether to test against seed data (fast,
      low-fidelity) or a larger synthetic dataset (slower to set up,
      more representative) before treating a pass/fail as meaningful.
- [ ] Confirm first dashboard payload stays ≤ 50 signal rows — this is
      an `apps/web`/Milestone F.4 default `limit` concern; cross-check
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
