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

|| Scenario | What happens without Hiring Signals | What Hiring Signals does |
|| :--- | :--- | :--- |
|| **Company growth tracking** | Manual monitoring of individual company career pages and job boards | Automated ingestion from multiple ATS providers with normalized signal detection and trend analysis |
|| **Competitive intelligence** | Spotty visibility into competitor hiring patterns and expansion plans | Comprehensive signal feed with evidence tracking across companies, roles, and locations |
|| **Investment research** | Time-consuming manual research of target company hiring activity | Faceted search and filtering with signal evidence for informed investment decisions |
|| **Market analysis** | Limited understanding of industry-wide hiring trends and skill demand | Aggregated signals across companies with role taxonomy and location-based filtering |
|| **Talent acquisition** | Reactive approach to market talent availability and competition | Proactive monitoring of competitor hiring patterns and skill demand analysis |

---

## 📑 Table of Contents

- [Use Cases](#-use-cases)
- [Tech Stack](#-tech-stack)
- [Layout](#layout)
- [Status](#status-2026-08-03-phases-0-1--milestones-a-e-h-i1-i2-complete-milestone-f-dashboard-ui-in-progress--app-shell--base-primitives-done-signal-feedfiltersdetail-not-yet-built-milestone-g-hardening-largely-audited-and-closed)
- [Key Features](#key-features)
- [Local dev](#local-dev)
- [AI Agent Metadata](#ai-agent-metadata)
- [License](#license)
- [Support Development](#-support-development)
- [Related Projects](#-related-projects)

---

## Layout

```
apps/web/        Next.js 16 UI -> Cloudflare Pages (app shell + design tokens + base
                  primitives done [Milestone F.1-F.3]; signal feed/filters/detail
                  still pending [F.4-F.7])
apps/api/        Cloudflare Worker API: routes, middleware, cron scheduler,
                  queue consumer, reconciliation job, semantic-search service
packages/domain/ Zod schemas, taxonomies, classification, lifecycle,
                  signal scoring (v2), embedding-text, search-merge logic
packages/adapters/ AtsAdapter interface (spec 5.3); 8 of 11 P0 providers built
                  (greenhouse, lever, ashby, smartrecruiters, workable, recruitee,
                  personio, breezy); teamtailor/jazzhr/bamboohr blocked -- no
                  constructable unauthenticated per-company endpoint (see ROADMAP.md
                  Milestone E)
packages/db/     D1 client + repository functions -- read paths (signals/
                  companies/facets), write paths (sources/jobs/signals),
                  company-role activity stats
packages/ui/     Optional shared UI primitives (not scaffolded; see its README)
infrastructure/  D1 migrations (0001-0004 landed), ops scripts (add-source,
                  update-source, add-company, source-health, backfill-embeddings)
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

## Status (2026-08-03): Phases 0-1 + Milestones A-E, H, I.1-I.2 complete; Milestone F (dashboard UI) in progress — app shell + base primitives done, signal feed/filters/detail not yet built; Milestone G (hardening) largely audited and closed

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
- **Milestone H — Signal-quality logic pass:** real Volume/Acceleration/Breadth scoring (`score_version` v2, replacing the v1 fixed-0.5 stub), company-level signal generation (`hiring_burst`, `role_acceleration`, `multi_location`, `persistent_demand` — previously typed but never created), a description-channel classification-noise fix, and a daily reconciliation job (`apps/api/src/jobs/reconciliation.ts`) that recomputes stale active signals' scores without touching `last_detected_at`
- **Milestone I.1-I.2 — Semantic search, write path only:** `hiring-signals-jobs` Vectorize index (768-dim, cosine) + Workers AI binding provisioned; jobs are embedded and upserted into Vectorize at ingest time (`embedAndUpsertJob` in `ingest-consumer.ts`), best-effort and non-blocking (an embedding failure never fails ingestion). The query-side service (`apps/api/src/services/semantic-search.ts`) and merge logic (`packages/domain/src/signal-search-merge.ts`) are both implemented but **not yet called from `GET /api/v1/signals`** — see Milestone I.3 in `ROADMAP.md`
- **Milestone F.1-F.3 — Dashboard app shell (closed):** `apps/web` is no longer scaffold-only. Minimal Brutalist design tokens (`--ink`/`--paper`/`--accent`/`--font-display`/`--font-mono`, WCAG-checked chartreuse-on-black) landed in `globals.css`; base UI primitives (`Button`, `Input`, `Checkbox`, `DataLabel`) and the app shell (`AppShell` + `Masthead` with a reduced-motion-gated animated wordmark, `ScrollProgress`) are built and wired into the root layout, verified at desktop/320px/200%-zoom widths. F.2's verification also caught and fixed a real bug: the strict CSP (G.2) blocked Turbopack's inline HMR scripts under `next dev`, breaking the dev client; `next.config.ts` now branches on Next's `PHASE_DEVELOPMENT_SERVER` (not `process.env.NODE_ENV`, which is non-standard on this machine) to relax `script-src` in dev only, confirmed not to leak into `next build`/`next start`. Signal feed, filters, and signal detail (F.4-F.7) are not yet built — `/` currently renders a placeholder.
- **Milestone G.1-G.2 — Backend hardening audit:** full spec §14.1 checklist walked against `apps/api`'s actual code — SQL parameterization, SSRF allow-listing, log redaction, and security headers all confirmed solid; the two real gaps found (no CI dependency scanning, no CSP on `apps/web`) are closed (`pnpm audit` added to CI as warn-only with a dated baseline, CSP + security headers added to `apps/web`). G.3-G.7 (privacy copy, performance targets, observability, CI/CD strategy, final sign-off) not yet started.
- **`/api/v1/admin/*` (spec §13.5a):** re-added after the earlier no-auth removal, but as a narrow, secret-bearer-token-gated set of three idempotent pipeline triggers (source-run, scheduler-flush, reconcile) — never a login a user sees, never reachable from `apps/web`, and source add/edit still lives only in the local ops scripts

Test coverage (2026-08-03, re-verified): domain 70 and adapters 114 tests, both pure/fixture-based and fast (<2s each). `packages/db` and `apps/api` are integration-tested against a real, shared, live Cloudflare D1 database (`AGENTS.md`'s "zero mocks, zero fakes" policy) rather than an in-memory fake — `packages/db` has 72 tests (~12 min, since every test round-trips the network); `apps/api` (`ingest-consumer`, `scheduler`, `reconciliation`) is larger still and can take 20-30+ min end to end. Because these share one live database, running the full suite concurrently (`pnpm -r test`) can produce a handful of intermittent timeouts/FK-race failures under load (observed: 2/72 in `packages/db`, similar pattern in `apps/api`) — every such failure re-ran clean in isolation, so treat a lone failure on a full concurrent run as a rerun-it signal, not necessarily a regression, before treating it as a real bug. `pnpm -r typecheck` and `pnpm -r lint` are clean across all workspace projects (lint: 0 errors, 6 pre-existing warnings -- 5 `no-console` in a smoke-test script, 1 `consistent-type-imports` in a test file).

Not yet done:

- 3 blocked P0 ATS adapters (Teamtailor, JazzHR, BambooHR — spec §4.1/§5.3): investigated and confirmed to have no constructable unauthenticated per-company endpoint; not planned unless that changes upstream
- Dashboard signal feed, filters, and signal detail (Milestone F.4-F.7) — app shell + design tokens + base primitives (F.1-F.3) are done (see above); `/signals` feed/filter-rail, `/signals/[id]` detail, empty/loading/error states, and the accessibility pass remain. Animation/interaction approach: `ArxivExplorer`'s mechanics (scroll progress, card hover/lift, staggered text entrance) restyled from scratch against spec §11's Brutalist tokens, never its neon visual styling — see `ROADMAP.md` Milestone F.
- Query-side hybrid search wiring + backfill script + search UI (Milestone I.3/I.4) and classification assist (I.5, deferred until I.3/I.4 ship)
- CSV export endpoint (spec §10.6)
- Production deployment (Cloudflare Pages + Workers)

## 🚀 Key Features

### Signal Detection

- **Role-level signals**: New matching roles, reopened roles, still active roles
- **Company-level signals**: Hiring bursts, role acceleration, multi-location expansion, persistent demand
- **Evidence trails**: Source platform, canonical public URL, source job identifier, timestamps

### Core Functionality

- **Multi-ATS integration**: Official documented ATS API adapters (no scraping)
- **Real-time monitoring**: Scheduled ingestion with adaptive cadence per provider
- **Filtering**: By role, location, source, signal type, and company (query params live; keyword `q` search on company/headline/summary works today, semantic search is write-path only — see Status)
- **Export**: CSV export of filtered signal list (spec §10.6, not yet built)
- **Health isolation**: Per-source error isolation prevents cascading failures

### Design Philosophy

- **Minimal Brutalist**: Strict black/white system, dense information, hard edges
- **Pull-only**: No push notifications, email digests, or webhook alerting (v1)
- **Evidence-based**: Every signal includes verifiable public evidence
- **Privacy-first**: No personal data collection, no social network scraping

## Local dev

```bash
pnpm install
pnpm --filter @hiring-signals/web dev     # Next.js dev server
pnpm --filter @hiring-signals/api dev     # wrangler dev (Worker API)
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
