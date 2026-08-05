# Hiring Signals Intelligence

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Pages-orange?logo=cloudflare)](https://pages.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-Manager-red?logo=pnpm)](https://pnpm.io/)
[![D1 Database](https://img.shields.io/badge/D1-Database-FF8C00?logo=cloudflare)](https://developers.cloudflare.com/d1/)
[![Hono](https://img.shields.io/badge/Hono-Framework-E26046?logo=hono)](https://hono.dev/)

> **AI Agent Discovery**: This project includes optimized metadata for AI agents. See [`llm.txt`](llm.txt) for machine-readable project summary and [`project-metadata.json`](project-metadata.json) for structured metadata.

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

- [Hiring Signals Intelligence](#hiring-signals-intelligence)
  - [🎯 Use Cases](#-use-cases)
    - [Primary Use Case](#primary-use-case)
    - [Target Users](#target-users)
  - [📑 Table of Contents](#-table-of-contents)
  - [Layout](#layout)
  - [🛠 Tech Stack](#-tech-stack)
  - [🚀 Key Features](#-key-features)
    - [Signal Detection](#signal-detection)
    - [Core Functionality](#core-functionality)
    - [Design Philosophy](#design-philosophy)
  - [Local dev](#local-dev)
  - [🤖 AI Agent Metadata](#-ai-agent-metadata)
  - [License](#license)
  - [💼 Support Development](#-support-development)
  - [🌐 Related Projects](#-related-projects)
    - [AI Agent Coordination \& Memory](#ai-agent-coordination--memory)
    - [Security Tools](#security-tools)
    - [MCP Security Servers](#mcp-security-servers)
    - [Privacy \& Encryption](#privacy--encryption)

---

## Layout

| Directory | Purpose | Status & Details |
|-----------|---------|-----------------|
| `apps/web/` | Next.js 16 UI dashboard | **Complete** → Deploys to Cloudflare Pages. Full signal feed (`/signals`) with filter rail, signal cards, loading/error/empty states. Signal detail page (`/signals/[signalId]`) with evidence table, score breakdown, and trend blocks. App shell + Brutalist design tokens + base primitives all complete. |
| `apps/api/` | Cloudflare Worker API | **Complete** → Routes, middleware, cron scheduler, queue consumer, reconciliation job, semantic-search service, CSV export route, secret-bearer-token admin triggers. |
| `packages/domain/` | Core domain logic | **Complete** → Zod schemas, taxonomies, classification, lifecycle, signal scoring (v2), embedding-text, search-merge logic. |
| `packages/adapters/` | ATS provider integrations | **8 of 11 P0 providers built** → AtsAdapter interface (spec 5.3). Implemented: greenhouse, lever, ashby, smartrecruiters, workable, recruitee, personio, breezy. Blocked: teamtailor/jazzhr/bamboohr (no constructable unauthenticated per-company endpoint — see ROADMAP.md Milestone E). |
| `packages/db/` | D1 database layer | **Complete** → D1 client + repository functions. Read paths: signals/companies/facets/export. Write paths: sources/jobs/signals. Company-role activity stats, signals-export repo. |
| `packages/test-support/` | Testing infrastructure | **Complete** → Live Cloudflare bindings for zero-mocks integration testing (live D1 client, live AI/Vectorize/KV, remote transport layer). Used by packages/db and apps/api suites. |
| `packages/ui/` | Shared UI primitives | **Not scaffolded** → Optional shared UI primitives (see its README for details). |
| `lib/` | Cross-workspace utilities | **Complete** → D1 helpers (client, LIKE pattern, unique-constraint), HTTP primitives (circuit-breaker, safeRateLimitIdentifier SHA-256 hashing, rate-limit, trusted IP extraction, security-headers), KV TTL store, audit logging, cursor pagination, text utilities (base64url, content-hash, CSV, location-mode). |
| `infrastructure/` | DevOps & migrations | **Complete** → D1 migrations (0001-0004 landed). Ops scripts: add-source, update-source, add-company, source-health, backfill-embeddings, import-sources. |

## 🛠 Tech Stack

- **Frontend**: Next.js 16, TypeScript 5.x, Tailwind CSS
- **Backend**: Cloudflare Workers with Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Search**: Workers AI (`@cf/baai/bge-base-en-v1.5` embeddings) + Vectorize (semantic search, write path only -- query path not yet wired into the live route)
- **Package Manager**: pnpm workspace
- **Deployment**: Cloudflare Pages (UI) + Cloudflare Workers (API)
- **Validation**: Zod schemas
- **Code Quality**: ESLint, Prettier, strict TypeScript


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
