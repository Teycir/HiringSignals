# Hiring Signals Intelligence

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Pages-orange?logo=cloudflare)](https://pages.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-Manager-red?logo=pnpm)](https://pnpm.io/)
[![D1 Database](https://img.shields.io/badge/D1-Database-FF8C00?logo=cloudflare)](https://developers.cloudflare.com/d1/)
[![Hono](https://img.shields.io/badge/Hono-Framework-E26046?logo=hono)](https://hono.dev/)

> **AI Agent Discovery**: This project includes optimized metadata for AI agents. See [`llm.txt`](llm.txt) for machine-readable project summary and [`project-metadata.json`](project-metadata.json) for structured metadata.

Build spec: `hiring-signals-spec.md` at repo root. Read that first — this
README only tracks implementation status; `ROADMAP.md` has the full
task-by-task breakdown this file summarizes.

---

## 🎯 Use Cases

Hiring Signals Intelligence provides actionable insights from hiring activity across multiple ATS providers.

### Primary Use Case

**Job Discovery & Hiring Intelligence** - A web dashboard that surfaces genuine, matching IT job postings as soon as they appear publicly across multiple ATS providers. Built for job seekers who want to see openings before the crowd.

### Target Users

- **Job seekers (IT specialists)**: See genuine, matching, still-open postings as soon as possible after they go live
- **Passive job seekers**: Maintain saved role/location filters and periodically check a dashboard
- **Administrators**: Manage source coverage, retention, and system health

| Scenario | What happens without Hiring Signals | What Hiring Signals does |
| :--- | :--- | :--- |
| **Company growth tracking** | Manual monitoring of individual company career pages and job boards | Automated ingestion from multiple ATS providers with normalized signal detection and trend analysis |
| **Competitive intelligence** | Spotty visibility into competitor hiring patterns and expansion plans | Comprehensive signal feed with evidence tracking across companies, roles, and locations |
| **Investment research** | Time-consuming manual research of target company hiring activity | Faceted search and filtering with signal evidence for informed investment decisions |
| **Market analysis** | Limited understanding of industry-wide hiring trends and skill demand | Aggregated signals across companies with role taxonomy and location-based filtering |
| **Talent acquisition** | Reactive approach to market talent availability and competition | Proactive monitoring of competitor hiring patterns and skill demand analysis |

---

## 📑 Table of Contents

- [Use Cases](#-use-cases)
- [Tech Stack](#-tech-stack)
- [Layout](#layout)
- [Status](#status-2026-08-04-phases-0-1--milestones-a-m-complete-except-j2-follow-ups-k2-latency-metric-l2-export-ui-button-milestone-g-hardening-largely-audited-and-closed-milestones-n-q-saved-filters-company-page-trends-velocity-not-yet-started)
- [Key Features](#key-features)
- [Local dev](#local-dev)
- [AI Agent Metadata](#ai-agent-metadata)
- [License](#license)
- [Support Development](#-support-development)
- [Related Projects](#-related-projects)

---

## Layout

```
apps/web/        Next.js 16 UI -> Cloudflare Pages. Full signal feed (/signals)
                  with filter rail, signal cards, loading/error/empty states;
                  signal detail page (/signals/[signalId]) with evidence
                  table, score breakdown, and trend blocks. App shell +
                  Brutalist design tokens + base primitives all complete.
apps/api/        Cloudflare Worker API: routes, middleware, cron scheduler,
                  queue consumer, reconciliation job, semantic-search service,
                  CSV export route, secret-bearer-token admin triggers
packages/domain/ Zod schemas, taxonomies, classification, lifecycle,
                  signal scoring (v2), embedding-text, search-merge logic
packages/adapters/ AtsAdapter interface (spec 5.3); 8 of 11 P0 providers built
                  (greenhouse, lever, ashby, smartrecruiters, workable, recruitee,
                  personio, breezy); teamtailor/jazzhr/bamboohr blocked -- no
                  constructable unauthenticated per-company endpoint (see ROADMAP.md
                  Milestone E)
packages/db/     D1 client + repository functions -- read paths (signals/
                  companies/facets/export), write paths (sources/jobs/signals),
                  company-role activity stats, signals-export repo
packages/test-support/ Live Cloudflare bindings for zero-mocks integration
                  testing (live D1 client, live AI/Vectorize/KV, remote
                  transport layer). Used by packages/db and apps/api suites.
packages/ui/     Optional shared UI primitives (not scaffolded; see its README)
lib/             Cross-workspace utilities: D1 helpers (client, LIKE pattern,
                  unique-constraint), HTTP primitives (circuit-breaker,
                  rate-limit, security-headers), KV TTL store, audit logging,
                  cursor pagination, text utilities (base64url, content-hash,
                  CSV, location-mode)
infrastructure/  D1 migrations (0001-0004 landed), ops scripts (add-source,
                  update-source, add-company, source-health, backfill-embeddings,
                  import-sources)
```

## 🛠 Tech Stack

- **Frontend**: Next.js 16, TypeScript 5.x, Tailwind CSS
- **Backend**: Cloudflare Workers with Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Search**: Workers AI (`@cf/baai/bge-base-en-v1.5` embeddings) + Vectorize (semantic search, write path only -- query path not yet wired into the live route)
- **Package Manager**: pnpm workspace
- **Deployment**: Cloudflare Pages (UI) + Cloudflare Workers (API)
- **Validation**: Zod schemas
- **Code Quality**: ESLint, Prettier, strict TypeScript

## Status (2026-08-04): Phases 0-1 + Milestones A-M complete (except J.2 follow-ups, K.2 latency metric, L.2 export UI button); Milestone G (hardening) largely audited and closed; Milestones N-Q (saved filters, company page, trends, velocity) not yet started

See `ROADMAP.md` for the full task-by-task breakdown; this is a summary,
kept in sync with it rather than a competing status source.

Done:

- **Phase 0 — Scaffolding:** pnpm workspace, strict TypeScript base config, Prettier, shared ESLint base, Next.js 16 + Tailwind `apps/web`, Hono Worker `apps/api` with middleware chain, `packages/domain` core schemas, provisioned D1/KV/Queue/Vectorize/Workers AI resources, anti-abuse middleware wired
- **Phase 1 — D1 schema + read paths:** Full schema (migrations 0001-0004), parameterized D1 client, cursor-paginated signal feed (score_desc/newest/company_asc), company autocomplete/detail/recent-signals, KV-cached facet counts, all GET routes (`/api/v1/signals`, `/signals/:id`, `/companies`, `/companies/:slug`, `/facets`, `/sources`) query D1, locationMode/country/source filters via EXISTS subqueries
- **Milestone A — Write-path repositories:** `sources-repo.ts`, `jobs-repo.ts`, `companies-repo.ts` (createCompany added post-A), seed fixtures (`seed-local-d1.sql`)
- **Milestone B — Classification & lifecycle:** Deterministic title/department/description classification with confidence scoring, negative-term guards, lifecycle state machine (active→possibly_closed→closed→reopened)
- **Milestone C — Signal generation (new_job):** `computeNewJobScore`, `signals-write-repo.ts` (createSignal/refreshSignal/findActiveSignal/appendSignalEvidence)
- **Milestone D — Scheduler, queue consumer, ops scripts:** `apps/api/src/jobs/scheduler.ts` (due-source enqueue with per-source jitter, never fetches), `apps/api/src/jobs/ingest-consumer.ts` (full fetch→validate→normalize→upsert→observe→lifecycle→classify→score→signal pipeline, idempotent per (sourceId, runId), every §13.4 failure branch handled), `infrastructure/scripts/` ops CLIs (add-source, update-source, add-company, source-health)
- **Milestone E — Adapters (closed):** 8 of 11 P0 providers built and fixture-tested with location inference and malformed-payload handling (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio, Breezy). The remaining 3 (Teamtailor, JazzHR, BambooHR) are investigated-and-blocked, not built -- each verified against its own vendor docs to have no constructable unauthenticated per-company endpoint, and removed from the active build list (kept in the domain enum/seed data). See `ROADMAP.md` Milestone E for the per-provider verification notes.
- **Milestone F — Dashboard UI (complete):** Full signal feed at `/signals` with bidirectional URL-param filter rail (role, company combobox, score, signal type, source, work mode, recency), paginated signal cards with hover/lift states, reduced-motion-gated animated tagline, and scroll progress. Signal detail page at `/signals/[signalId]` with evidence table, score breakdown, trend block, and loading/error/not-found states. Brutalist design tokens verified at desktop/320px/200%-zoom. CSP dev-mode HMR fix (PHASE_DEVELOPMENT_SERVER check) landed during F.2 verification.
- **Milestone H — Signal-quality logic pass:** real Volume/Acceleration/Breadth scoring (`score_version` v2, replacing the v1 fixed-0.5 stub), company-level signal generation (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand` — previously typed but never created), a description-channel classification-noise fix, and a daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`) that recomputes stale active signals' scores without touching `last_detected_at`
- **Milestone I.1-I.2 — Semantic search, write path only:** `hiring-signals-jobs` Vectorize index (768-dim, cosine) + Workers AI binding provisioned; jobs are embedded and upserted into Vectorize at ingest time (`embedAndUpsertJob` in `ingest-consumer.ts`), best-effort and non-blocking (an embedding failure never fails ingestion). The query-side service (`apps/api/src/services/semantic-search.ts`) and merge logic (`packages/domain/src/signal-search-merge.ts`) are both implemented but **not yet called from `GET /api/v1/signals`** — see Milestone I.3 in `ROADMAP.md`
- **Milestone J.1 — Zero-mocks test migration + CI workflow:** `packages/test-support/` package implemented with live Cloudflare bindings (`live-d1-database`, `live-ai-binding`, `live-vectorize-index`, `live-kv-namespace`) and remote D1 transport via wrangler CLI. `apps/api/test/jobs/ingest-consumer.test.ts` fully migrated to live resources (21 tests against real D1/AI/Vectorize). `.github/workflows/ci.yml` added: Node 24.18.0, pnpm 11.17.0, runs typecheck + lint + domain (70 tests) + adapters (114 tests) on every push/PR (~45s total). Live-D1/db/api suites are manual-only by deliberate cost/risk decision (shared production D1, ~25 min full suite).
- **Milestone K.1 — `still_active` signal:** Daily reconciliation pass appends `still_active` evidence rows to recently-confirmed-open active `new_job` signals, preventing score decay for listings that stay live. Trigger: `status='active'` AND job `last_seen_at` within `pollIntervalMinutes * 1.5` AND signal `last_detected_at` older than 24h. String-comparison bug fixed during verification (SQLite `datetime()` space-separated vs. ISO T/Z timestamps normalized).
- **Milestone L.1 — CSV export endpoint:** `GET /api/v1/export/signals.csv` accepts same full filter set as `/api/v1/signals`, returns RFC 4180 CSV via `lib/text/csv.ts` (zero-dependency encoder). Cap 2000 rows with `X-Export-Truncated: true` header when exceeded. All job/company public fields only (spec §14.2), same `freeReadTier` middleware. `signals-export-repo.test.ts` (5 tests) verified against live D1.
- **Milestone M.1 — Bulk source onboarding (CSV import):** `infrastructure/scripts/import-sources.mjs` with two-pass plan/apply design, RFC 4180 CSV parser (no dep), idempotent re-runs (skip existing sources), company auto-creation per slug. Verified against local D1 with 4-row test fixture including in-file duplicate and shared-company sources.
- **Milestone G.1-G.2 — Backend hardening audit:** full spec §14.1 checklist walked against `apps/api`'s actual code — SQL parameterization, SSRF allow-listing, log redaction, and security headers all confirmed solid; the two real gaps found (no CI dependency scanning, no CSP on `apps/web`) are closed (`pnpm audit` added to CI as warn-only with a dated baseline, CSP + security headers added to `apps/web`). G.3-G.7 (privacy copy, performance targets, observability, CI/CD strategy, final sign-off) not yet started.
- **`/api/v1/admin/*` (spec §13.5a):** re-added after the earlier no-auth removal, but as a narrow, secret-bearer-token-gated set of three idempotent pipeline triggers (source-run, scheduler-flush, reconcile) — never a login a user sees, never reachable from `apps/web`, and source add/edit still lives only in the local ops scripts

Test coverage (2026-08-04): pure-logic suites fast and deterministic — `packages/domain` 70 tests, `packages/adapters` 114 tests, both <2s. Integration suites use live shared Cloudflare resources per `AGENTS.md`'s zero-mocks policy: `packages/db` 72 tests (~12 min, network round-trips per assertion); `apps/api` (`ingest-consumer`, `scheduler`, `reconciliation`) migrated to live bindings with `packages/test-support`. Known live-D1 caveats: load-related flakiness under concurrent full-suite runs (accepted trade-off of shared DB); `ingest-consumer`/`reconciliation` single-test runs can exceed 90s timeout at peak remote latency (noted in `AGENTS.md`, not a correctness failure). `pnpm -r typecheck` and `pnpm -r lint` clean across 6 workspace projects (lint: 0 errors, pre-existing warnings limited to smoke-test `no-console` and one test-file `consistent-type-imports`).

Not yet done:

- 3 blocked P0 ATS adapters (Teamtailor, JazzHR, BambooHR — spec §4.1/§5.3): investigated and confirmed to have no constructable unauthenticated per-company endpoint; not planned unless that changes upstream
- Query-side hybrid search wiring + backfill script + search UI (Milestone I.3/I.4) and classification assist (I.5, deferred until I.3/I.4 ship)
- CSV export button in dashboard UI (Milestone L.2, spec §10.2 masthead `[EXPORT CSV]` — route implemented, UI button not yet wired to filter state)
- `packages/test-support` follow-ups (Milestone J.2 follow-ups list): dotenv parser for `.env.local`, factored `execRemote` helper, credential preflight consistency, error truncation, package README
- Detection-latency tracking metric (Milestone K.2): p50/p95 per source, surfaced in `source-health.mjs`
- Saved filters (Milestone N): client-side `localStorage` filter profile save/restore
- Company hiring timeline page + API (Milestone O): `/companies/[slug]` timeline view, `/api/v1/companies/:slug/timeline` endpoint
- Cross-company hiring trends API + page (Milestone P)
- Company-level hiring velocity score (Milestone Q)
- Production deployment (Cloudflare Pages + Workers)

## 🚀 Key Features

### Signal Detection

- **Role-level signals**: New matching roles, reopened roles, still active roles (daily reconciliation appends `still_active` evidence to prevent score decay)
- **Company-level signals**: Hiring bursts, role acceleration, multi-location expansion, persistent demand
- **Evidence trails**: Source platform, canonical public URL, source job identifier, timestamps

### Core Functionality

- **Multi-ATS integration**: Official documented ATS API adapters (no scraping) — 8 of 11 P0 providers built
- **Real-time monitoring**: Scheduled ingestion with adaptive cadence per provider
- **Filtering**: By role, location, source, signal type, and company (URL-param + UI filter rail live at `/signals`; keyword `q` search on company/headline/summary works today; semantic search is write-path only — see Status)
- **Dashboard UI**: Full signal feed at `/signals` with paginated cards, filter rail (role/company/score/source/signal-type/work-mode/recency), and loading/error/empty states. Signal detail page at `/signals/[signalId]` with evidence table, score breakdown, trend block.
- **Export**: CSV export of filtered signal list via `GET /api/v1/export/signals.csv` (same filters as signal feed, 2000-row cap with truncation header; UI export button pending)
- **Bulk onboarding**: CSV import (`import-sources.mjs`) for batch source/company onboarding
- **Health isolation**: Per-source error isolation prevents cascading failures

### Design Philosophy

- **Minimal Brutalist**: Strict black/white system, dense information, hard edges
- **Pull-only**: No push notifications, email digests, or webhook alerting (v1)
- **Evidence-based**: Every signal includes verifiable public evidence
- **Privacy-first**: No personal data collection, no social network scraping

## Local dev

```bash
pnpm install
pnpm --filter @hiring-signals/web dev     # Next.js dev server (dashboard at /signals)
pnpm --filter @hiring-signals/api dev     # wrangler dev (Worker API)
```

Ops scripts (run from repo root, requires `nvm use 24.18.0` for wrangler's Node >=22):

```bash
node infrastructure/scripts/add-company.mjs --help
node infrastructure/scripts/add-source.mjs --help
node infrastructure/scripts/import-sources.mjs path/to/sources.csv   # bulk CSV onboarding
node infrastructure/scripts/source-health.mjs                    # source status table
node infrastructure/scripts/backfill-embeddings.mjs               # Vectorize backfill (semantic search)
```

Quality commands:

```bash
pnpm -r typecheck                           # all 6 workspace projects
pnpm -r lint                                 # ESLint across workspaces
pnpm --filter @hiring-signals/domain test   # fast pure-logic suite (70 tests, ~1s)
pnpm --filter @hiring-signals/adapters test # fast fixture suite (114 tests, ~3s)
# packages/db and apps/api suites require live CF_TOKEN — see AGENTS.md zero-mocks policy
# Scope live tests to one file at a time: cd packages/db && npx vitest run test/signals-export-repo.test.ts
```

`apps/api`'s `wrangler.toml` is wired to real Cloudflare resources: the
`hiring-signals` D1 database; three separate KV namespaces (`CACHE` for
facet/rate-limit/query-embedding caching, `RAW_PAYLOADS` for the 30-day
TTL raw source-response archive, `ABUSE_LOGS` for the abuse/audit event
log -- split into separate namespaces so IAM can scope read access
narrowly, per a security review); the `hiring-signals-ingest` queue; and
the `hiring-signals-jobs` Vectorize index + Workers AI binding for
semantic search (write path only so far -- see Status). Raw payloads
live in KV under TTL-based keys rather than R2, so the project doesn't
require Cloudflare billing/a credit card on the account.

CI (`.github/workflows/ci.yml`) runs on every push/PR to `main`:
typecheck + lint + domain/adapters pure-logic tests (~45s total).
Live-D1/db/api suites are manual-only (see Status).

---

## 🤖 AI Agent Metadata

This project includes optimized metadata files for AI agent discovery and understanding:

- **[`llm.txt`](llm.txt)** - Machine-readable project summary optimized for LLM consumption
- **[`project-metadata.json`](project-metadata.json)** - Structured JSON metadata with comprehensive project information

These files enable AI agents to:

- Quickly understand project architecture and tech stack
- Identify implementation patterns and conventions
- Access structured project metadata for automated analysis
- Understand current development status and pending work

For human-readable documentation, refer to [`hiring-signals-spec.md`](hiring-signals-spec.md) for the complete build specification.

---

## License

MIT License

Copyright (c) 2026 Teycir Ben Soltane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 💼 Support Development

If this project helps your work, support ongoing maintenance and new features.

**ETH Donation Wallet**  
`0x11282eE5726B3370c8B480e321b3B2aA13686582`

<a href="https://etherscan.io/address/0x11282eE5726B3370c8B480e321b3B2aA13686582">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=0x11282eE5726B3370c8B480e321b3B2aA13686582" alt="Ethereum donation QR code" width="220" />
</a>

_Scan the QR code or copy the wallet address above._

---

## 🌐 Related Projects

More projects from the same author — not part of Hiring Signals, listed for
discovery only:

### AI Agent Coordination & Memory

- **[Butler](https://github.com/Teycir/Butler)** - Persistent coordination and memory layer for AI coding agents. Cross-tool session continuity, TODO tracking, and shared project state.
- **[SkillsGuard](https://github.com/Teycir/SkillsGuard)** - Security audit tool for AI agent skill packages. Detects prompt injection, exfiltration, and supply-chain attacks.

### Security Tools

- **[BurpAPISecuritySuite](https://github.com/Teycir/BurpAPISecuritySuite)** - Burp Suite extension for API security testing. 15 attack types, 108+ payloads, BOLA/IDOR detection.
- **[Mcpwn](https://github.com/Teycir/Mcpwn)** - Automated security scanner for Model Context Protocol servers. Detects RCE, path traversal, prompt injection.
- **[DiffCatcher](https://github.com/Teycir/DiffCatcher)** - Git repo discovery, diff capture, code element extraction.
- **[HoneypotScan](https://github.com/Teycir/HoneypotScan)** - Honeypot detection service for security research.
- **[CheckAPI](https://github.com/Teycir/CheckAPI)** - LLM API key validator for multiple providers. Privacy-first, client-side validation.
- **[SeekYou](https://github.com/Teycir/SeekYou)** - Host intelligence aggregator — unified OSINT across 15 sources for IPs, domains, and ASNs.

### MCP Security Servers

- **[burp-mcp-server](https://github.com/Teycir/burp-mcp-server)** - MCP server for Burp Suite Professional. Vulnerability scanning via AI assistants.
- **[nuclei-mcp](https://github.com/Teycir/nuclei-mcp)** - MCP server for Nuclei. Multi-target scanning, severity filtering.
- **[nmap-mcp](https://github.com/Teycir/nmap-mcp)** - MCP server for Nmap. Stealth recon, vuln/NSE scanning.
- **[frida-mcp](https://github.com/Teycir/frida-mcp)** - MCP server for Frida. Dynamic instrumentation, SSL pinning bypass.

### Privacy & Encryption

- **[Timeseal](https://github.com/Teycir/Timeseal)** - Time-locked encryption vault with Dead Man's Switch. AES-256 split-key crypto, ephemeral seals.
- **[Sanctum](https://github.com/Teycir/Sanctum)** - Zero-trust encrypted vault with cryptographic plausible deniability. XChaCha20-Poly1305, Argon2id.
- **[GhostChat](https://github.com/Teycir/GhostChat)** - True P2P encrypted chat via WebRTC. No servers, no storage, self-destructing messages.
- **[xmrproof](https://github.com/Teycir/xmrproof)** - Monero payment verification, 100% client-side.
- **[GhostReceipt](https://github.com/Teycir/GhostReceipt)** - Anonymous receipt generation with zero-knowledge proofs.
