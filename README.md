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
README only tracks scaffolding status.

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
- [Status](#status-phase-0-complete-phase-1-d1--read-paths-in-progress)
- [Key Features](#key-features)
- [Local dev](#local-dev)
- [AI Agent Metadata](#ai-agent-metadata)
- [License](#license)
- [Support Development](#-support-development)
- [Related Projects](#-related-projects)

---

## Layout

```
apps/web/        Next.js 16 UI -> Cloudflare Pages
apps/api/        Cloudflare Worker API + scheduled ingestion (Hono)
packages/domain/ Zod schemas, shared types, role/provider taxonomies
packages/adapters/ AtsAdapter interface (spec 5.3); per-provider impls land in Phase 1
packages/db/     D1 client + repository functions (signals/companies/facets read paths)
packages/ui/     Optional shared UI primitives (not scaffolded; see its README)
infrastructure/  D1 migrations (0001_initial_schema.sql landed) + deploy scripts
```

## 🛠 Tech Stack

- **Frontend**: Next.js 16, TypeScript 5.x, Tailwind CSS
- **Backend**: Cloudflare Workers with Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Package Manager**: pnpm workspace
- **Deployment**: Cloudflare Pages (UI) + Cloudflare Workers (API)
- **Validation**: Zod schemas
- **Code Quality**: ESLint, Prettier, strict TypeScript

## Status: Phase 0, Phase 1, Milestones A-E complete — ingestion pipeline running

Done:

- **Phase 0 — Scaffolding:** pnpm workspace, strict TypeScript base config, Prettier, shared ESLint base, Next.js 16 + Tailwind `apps/web`, Hono Worker `apps/api` with middleware chain, `packages/domain` core schemas, provisioned D1/KV/Queue resources, anti-abuse middleware wired
- **Phase 1 — D1 schema + read paths:** Full schema (migrations 0001-0004), parameterized D1 client, cursor-paginated signal feed (score_desc/newest/company_asc), company autocomplete/detail/recent-signals, KV-cached facet counts, all GET routes (`/api/v1/signals`, `/signals/:id`, `/companies`, `/companies/:slug`, `/facets`) query D1, locationMode/country/source filters via EXISTS subqueries
- **Milestone A — Write-path repositories:** `sources-repo.ts` (getDueSources, createSource, updateSource, recordSourceRun, markSourceSuccess/Failure), `jobs-repo.ts` (upsertJob, insertJobObservation, getJobsMissingFromRun, applyLifecycleTransition), seed fixtures (`seed-local-d1.sql`)
- **Milestone B — Classification engine:** Lifecycle state machine (active→possibly_closed→closed→reopened), signal classification (new_matching_role/reopened_role/still_active_role/hiring_burst/demand_acceleration/multi_location_expansion), `computeNewJobScore` with freshness decay
- **Milestone C — Wiring:** `apps/api/src/jobs/scheduler.ts` (getDueSources + enqueue with per-source jitter), `apps/api/src/jobs/ingest-consumer.ts` (full fetch→validate→normalize→upsert→observe→lifecycle→classify→score→signal pipeline, idempotent per (sourceId, runId), retry on 429/5xx with exponential backoff, skip retry on 4xx/schema errors)
- **Milestone D — Source management ops:** `infrastructure/scripts/add-source.mjs`, `update-source.mjs`, `source-health.mjs` (shell out to `wrangler d1 execute --json`, no admin HTTP surface per no-auth decision)
- **Milestone E — Adapters:** Greenhouse adapter with location inference, Lever adapter. Both fixture-tested, handle malformed payloads gracefully
- **Post-D fixes:** Signal freshness anchored on job.postedAt (not scrape time), active-signal dedup bounded to 28-day lookback, test files isolated into per-package test/ folders, isUniqueConstraintError centralized in lib/d1/, ingest consumer skips retry on programmer/config errors, DB/CACHE test bindings replaced with throwing Proxy

Test coverage: 94 tests passing workspace-wide (`pnpm -r test`).

Not yet done:

- Remaining ATS adapters (9 providers: Workday, Lever, SmartRecruiters, Ashby, JazzHR, BambooHR, Breezy, Recruitee, Bullhorn — spec §5.3)
- Brutalist design tokens / dashboard UI (Phase 2)
- CSV export endpoint (spec §10.6)
- Production deployment (Cloudflare Pages + Workers)

## 🚀 Key Features

### Signal Detection

- **Role-level signals**: New matching roles, reopened roles, still active roles
- **Company-level signals**: Hiring bursts, demand acceleration, multi-location expansion
- **Evidence trails**: Source platform, canonical public URL, source job identifier, timestamps

### Core Functionality

- **Multi-ATS integration**: Official documented ATS API adapters (no scraping)
- **Real-time monitoring**: Scheduled ingestion with adaptive cadence per provider
- **Filtering**: By role, location, and company
- **Export**: CSV export of filtered signal list
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

`apps/api`'s `wrangler.toml` is wired to real Cloudflare D1/KV/Queue
resources (`hiring-signals` D1 database, `CACHE` KV namespace,
`hiring-signals-ingest` queue) -- raw source-response archival and export
artifacts live in KV under TTL-based keys rather than R2, so the project
doesn't require Cloudflare billing/a credit card on the account.

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
