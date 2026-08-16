<div align="center">

# Hiring Signals Intelligence

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-Manager-red?logo=pnpm)](https://pnpm.io/)
[![D1 Database](https://img.shields.io/badge/D1-Database-FF8C00?logo=cloudflare)](https://developers.cloudflare.com/d1/)
[![Hono](https://img.shields.io/badge/Hono-Framework-E26046?logo=hono)](https://hono.dev/)

**Turn raw job postings into scored hiring signals — before they surface on LinkedIn.**

_"What is actually happening at this company, right now."_

</div>

> **AI Agent Discovery**: This project includes optimized metadata for AI agents. See [`llm.txt`](llm.txt) for machine-readable project summary and [`project-metadata.json`](project-metadata.json) for structured metadata.

---

## What it does

Hiring Signals watches company career pages — via official ATS APIs, no scraping — and turns raw job postings into scored, filterable **signals** you can query from a CLI or pipe into an AI agent.

Instead of returning a flat list of job postings, it detects *what is actually happening* at a company:

- A role just appeared for the first time → `new_job` signal
- A previously closed role came back → `reopened_job` signal
- Three or more new postings for the same role in 14 days → `hiring_burst` signal
- The pace of new postings is accelerating vs. the prior 56-day baseline → `role_acceleration` signal
- The same role is now posted across three or more distinct locations → `multi_location` signal
- A role has stayed continuously active for 30+ days → `persistent_demand` signal

Each signal gets a **priority score (0–100)** computed from freshness, posting volume, acceleration, location breadth, and classification confidence. Signals decay over time if no new evidence arrives, so a high score means something is actively happening right now.

The intended workflow:

1. You (or your AI assistant) run `hs signals list --role software_engineering --country US` once or on a schedule.
2. The CLI returns JSON — one object, stdout only, no interactive prompts — filtered and ranked by score.
3. You act on the top results before they surface on aggregator job boards.

Saved filter profiles (`hs signals list --save`) let an AI agent re-run your usual search with no flags at all, making periodic checks fully automated.

### What it covers

- **8 ATS providers**: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio, Breezy — all via their official documented APIs
- **10 IT role categories**: `software_engineering`, `ai_machine_learning`, `cloud_platform_devops_sre`, `cybersecurity`, `data_engineering_analytics`, `qa_test_automation`, `systems_network_administration`, `it_support_help_desk`, `product_technical_program_management`, `erp_business_systems`
- **Hybrid search**: `--q "distributed systems Rust"` runs keyword + semantic search (Workers AI embeddings + Vectorize) and merges results by relevance; falls back to keyword-only if the AI leg is unavailable
- **Hiring velocity per company**: A 0–100 investor-grade score per company (`V = 0.40*acceleration + 0.25*breadth + 0.20*volume + 0.15*persistence`) answering "how aggressively is this company building its team right now," surfaced on `GET /companies`, `GET /companies/:slug`, and `GET /trends/hiring?sort=velocity_desc` (null/uncomputed scores sort last)
- **Hiring trends**: `hs trends hiring --role ai_machine_learning` ranks companies across the whole dataset by acceleration, volume, newest-signal recency, or the velocity score above — useful for spotting which fintechs/defense/AI companies are ramping up in a given role area
- **Company hiring timelines**: `hs companies timeline <slug> --bucket-days 14` exposes time-bucketed new/closed/active jobs, role/location breakdowns, and signal types per bucket — due-diligence-grade evidence of how a specific company's hiring composition changed over time (90-day window cap, bucket widths 7/14/30 days)
- **RSS feed for push-style alerts**: `GET /api/v1/feed.rss` + `hs feed-url --role cybersecurity` lets a passive seeker subscribe via any feed reader (Feedly, NetNewsWire, etc.) instead of actively polling the CLI — `ETag`/`Last-Modified`/304 support, 50-item cap, filterable by all the same signal filters as the feed route
- **Export**: `hs export signals` dumps a filtered CSV (up to 2 000 rows) for offline analysis

### Who uses it

- **IT job seekers** who want to see a matching opening the day it goes live, not a week later when it's on LinkedIn
- **Passive job seekers** who tell their AI assistant to check their saved filters every morning
- **Analysts and investors** who want to track hiring velocity at specific companies or across an industry
- **Operators/admins** who manage source coverage and monitor ingestion health

---

## 📑 Table of Contents

- [Hiring Signals Intelligence](#hiring-signals-intelligence)
  - [What it does](#what-it-does)
    - [What it covers](#what-it-covers)
    - [Who uses it](#who-uses-it)
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
| `apps/cli/` | CLI, primary interface | **Complete** → landed 2026-08-07, `--format table` renderer added 2026-08-10. The real end-user is an AI agent, not a human typing commands, so JSON is the default on stdout with single-JSON-object machine-readable errors on stderr and no interactive prompts (admin actions require `--yes`). Thin client over `apps/api`'s existing routes only — no D1 access, no bypassing API validation/rate-limits/auth. Commands: `hs signals list/get`, `hs companies list/get/timeline`, `hs facets`, `hs sources list`, `hs export signals`, `hs feed-url`, `hs trends hiring`, `hs admin source run/scheduler flush/reconcile`. `--format table` works on flat-list commands; nested/dense shapes (signal detail, company detail, timeline buckets) fall back to JSON. Saved filter profiles (`--save`/`--clear-saved`) stored at `~/.hiring-signals/config.json` auto-apply on no-flag invocations. See `apps/cli/README.md` for exact invocations/output. |
| `apps/web/` | *Deleted 2026-08-07* | **Removed, not deprioritized** → the Next.js/Cloudflare Pages dashboard was fully deleted (not left in place) once the CLI-first decision confirmed it added no capability the CLI/API surface didn't already have — every route it called is one of the same `apps/api` endpoints the CLI uses. Milestone F shell + FilterRail/SignalCard routes and Milestone I.4 search UI (search bar + recent searches + MoreLikeThis) were all part of the deletion; ROADMAP.md carries full rationale and work-item history. |
| `apps/api/` | Cloudflare Worker API | **Complete** → Hono Worker. Routes: `GET /signals` (hybrid search, cursor pagination), `GET /signals/:id`, `GET /companies`, `GET /companies/:slug`, `GET /companies/:slug/timeline` (time-bucketed hiring activity, 7/14/30-day buckets, 90-day window cap), `GET /trends/hiring` (cross-company ranked analytics, acceleration/volume/velocity/newest-signal sorts, 5-min KV cache), `GET /facets` (60s KV cache), `GET /sources`, `GET /export/signals.csv` (2 000-row cap, `X-Export-Truncated` header), `GET /feed.rss` (RSS 2.0, 50-item cap, ETag/304 conditional requests). Three `POST /admin/*` pipeline triggers gated on bearer `HS_ADMIN_SECRET`. Middleware chain: request-id, client-IP (trusted-first CF-Connecting-IP extraction), security headers, circuit-breaker-wrapped D1 client, anti-abuse rate-limiting (SHA-256-hashed identifiers), free-read-tier enforcement, API error-rate metrics (Analytics Engine `API_METRICS` dataset with normalized route-shape cardinality). Background: 15-min cron scheduler → `INGEST_QUEUE` consumer with 5-retry exponential backoff, daily reconciliation cron (stale score recompute + company hiring velocity recompute). |
| `packages/domain/` | Core domain logic | **Complete** → Zod schemas, taxonomies, classification, lifecycle, signal scoring (v2), embedding-text, search-merge logic. |
| `packages/adapters/` | ATS provider integrations | **8 P0 providers built** → AtsAdapter interface (spec 5.3). Implemented: greenhouse, lever, ashby, smartrecruiters, workable, recruitee, personio, breezy. |
| `packages/db/` | D1 database layer | **Complete** → D1 client + repository functions. Read paths: signals/companies/facets/export. Write paths: sources/jobs/signals. Company-role activity stats, signals-export repo. |
| `packages/test-support/` | Testing infrastructure | **Complete** → Live Cloudflare bindings for zero-mocks integration testing (live D1 client, live AI/Vectorize/KV, remote transport layer). Used by packages/db and apps/api suites. |
| `lib/` | Cross-workspace utilities | **Complete** → D1 helpers (client, LIKE pattern, unique-constraint), HTTP primitives (circuit-breaker, rate-limit with SHA-256-hashed identifiers, trusted IP extraction, security-headers), KV TTL store, audit logging, cursor pagination, text utilities (base64url, content-hash, CSV, location-mode, RSS serializer). |
| `infrastructure/` | DevOps & migrations | **Complete** → D1 migrations (0001-0009 landed). Ops scripts: add-source, update-source, add-company, update-company, source-health, backfill-embeddings, import-sources, ingestion-metrics. |

## 🛠 Tech Stack

- **CLI**: Node, TypeScript 5.x (complete — see `apps/cli/README.md`)
- **Backend**: Cloudflare Workers with Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Search**: Workers AI (`@cf/baai/bge-base-en-v1.5` embeddings) + Vectorize (hybrid semantic search — embeddings stored at ingestion, query path wired as of Milestone I.3; page-1-only, degrades gracefully to keyword-only)
- **Package Manager**: pnpm workspace
- **Deployment**: Cloudflare Workers (API only — no separate frontend deployment target)
- **Validation**: Zod schemas
- **Code Quality**: ESLint, Prettier, strict TypeScript


## 🚀 Key Features

### Signal Detection

- **Role-level signals**: New matching roles, reopened roles, still active roles (daily reconciliation appends `still_active` evidence to prevent score decay)
- **Company-level signals**: Hiring bursts, role acceleration, multi-location expansion, persistent demand
- **Evidence trails**: Source platform, canonical public URL, source job identifier, timestamps

### Core Functionality

- **Multi-ATS integration**: Official documented ATS API adapters (no scraping) — 8 of 11 P0 providers built
- **Real-time monitoring**: Scheduled ingestion with adaptive cadence per provider; `still_active` evidence appended daily to prevent score decay on persistently-open roles
- **Signal scoring v2**: Priority score (0–100) = `0.35*freshness + 0.25*volume + 0.20*acceleration + 0.10*breadth + 0.10*classification_confidence`; decays over time with no new evidence
- **Hiring velocity per company**: Separate investor-grade 0–100 company-level score = `0.40*acceleration + 0.25*breadth + 0.20*volume_norm + 0.15*persistence`; recomputed daily during reconciliation for any company with signal activity that run, null for untouched companies (never fabricated as 0)
- **Filtering**: By role, location, source, signal type, company, min score, recency window via `GET /api/v1/signals` query params; `q` triggers hybrid search (keyword + semantic via Workers AI + Vectorize) on page 1, falls back to keyword-only on subsequent pages or if the semantic leg degrades. CLI exposure of these filters as flags is available via `hs signals list` — see `apps/cli/README.md`.
- **Saved filter profiles**: `hs signals list --save` persists raw pre-parse flag strings (not parsed defaults, so sort/limit/minScore aren't silently baked in) to `~/.hiring-signals/config.json`; running `hs signals list` with no flags auto-applies the saved profile, prints a one-line stderr note, exits cleanly. `--clear-saved` removes it.
- **Cross-company hiring trends**: `GET /trends/hiring` + `hs trends hiring` ranked company analytics with `acceleration_desc`/`volume_desc`/`newest_signal`/`velocity_desc` sorts, industry/country/role/recency filters, and per-company top-5-location breakdowns; KV-cached 5 minutes
- **Single-company hiring timelines**: `GET /companies/:slug/timeline` + `hs companies timeline` time-bucketed new/closed/active jobs per 7/14/30-day window (90-day cap) with role/location breakdowns and signal types per bucket; pure read path over existing observations
- **Push-style delivery via RSS**: `GET /feed.rss` + `hs feed-url` for feed-reader subscriptions, no accounts, no personal data. 50-item cap, ETag/Last-Modified/304 Not Modified conditional-request support. `<link>` omitted for aggregate signals with no job-linked evidence.
- **Export**: CSV export of filtered signal list via `GET /api/v1/export/signals.csv` (same filters as signal feed, 2000-row cap with truncation header; also exposed as `hs export signals` in CLI)
- **Bulk onboarding**: CSV import (`import-sources.mjs`) for batch source/company onboarding
- **Admin operations**: Secret-bearer-token-gated pipeline triggers (`POST /admin/source/:id/run`, `/admin/scheduler/flush`, `/admin/reconcile`) + local ops scripts for source/company CRUD. Source ingestion retry logic respects 429 `Retry-After` headers and caps exponential backoff at 5 attempts; permanent config/schema errors skip retry immediately.
- **Monitoring & observability**: `infrastructure/scripts/source-health.mjs` (stale/stuck/degraded detection), `ingestion-metrics.mjs` (success rate + duplicate rate with/without requisitionId tiering), and per-request Analytics Engine data points for API error rates/latency histograms
- **Health isolation**: Per-source error isolation prevents cascading failures

### Design Philosophy

- **Structured, scriptable output first**: JSON on stdout by default (single object, no prose mixed in), single-JSON-object errors on stderr with typed `error.code` fields for branching, no interactive prompts (admin actions require an explicit `--yes` flag, never a y/n keypress). `--format table` opt-in renderer for flat-list commands (`signals list`, `companies list`, `sources list`, `facets`, `trends hiring`) as a human-debugging convenience; genuinely nested shapes (signal detail with evidence[], company detail with timeline buckets, timeline output itself) decline table mode and fall back to JSON with a one-line stderr note.
- **Agent-first, human-also**: Every command and output shape assumes an AI agent will parse it on a person's behalf — no ASCII art banners, no animated spinners, no "friendly" reformatting that varies between runs, exit codes follow shell convention so an agent can branch on `$?` without parsing prose. A human reading a terminal gets the table renderer and the `apps/cli/README.md` examples, but they're convenience layers, not the primary contract.
- **Pull-and-feed, no direct push**: No email digests, no webhook alerting, no browser push notifications (v1). "Notify me later" is handled via the RSS feed route (`GET /feed.rss`) — that is, an external feed reader polls on the user's schedule, and `hs feed-url` builds the filtered URL. The project itself never stores a destination address to initiate outbound contact.
- **Evidence-based, never speculative**: Every signal includes verifiable public evidence (source platform, canonical URL, source job identifier, timestamps). Company-level hiring claims use the shared `HIRING_VELOCITY_DISCLAIMER`: "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget."
- **Privacy-first**: No personal data collection, no user accounts, no social network scraping. Rate-limit identifiers are SHA-256 base64url hashed before KV storage to scrub plaintext IP PII; client IP is extracted via trusted-first CF-Connecting-IP, never the untrusted first hop of X-Forwarded-For.

## Local dev

```bash
pnpm install
pnpm --filter @hiring-signals/api dev     # wrangler dev (Worker API)
```

There is no `pnpm dev` for the CLI -- it's not a server. Point it at a
running `apps/api` instead:

```bash
pnpm --filter @hiring-signals/api dev   # in one terminal
cd apps/cli && HS_API_BASE_URL=http://localhost:8787 node bin/hs.mjs facets   # in another
```

See `apps/cli/README.md` for every command's flags and exact JSON output.

Ops scripts (run from repo root, requires `nvm use 24.18.0` for wrangler's Node >=22):

```bash
node infrastructure/scripts/add-company.mjs --help
node infrastructure/scripts/add-source.mjs --help
node infrastructure/scripts/update-source.mjs --help
node infrastructure/scripts/update-company.mjs --help
node infrastructure/scripts/import-sources.mjs path/to/sources.csv   # bulk CSV onboarding
node infrastructure/scripts/source-health.mjs                    # source status table
node infrastructure/scripts/ingestion-metrics.mjs                # ingestion stats
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
hybrid semantic search (both paths live — embeddings stored at ingestion, query path wired as of Milestone I.3). Raw payloads
live in KV under TTL-based keys rather than R2, so the project doesn't
require Cloudflare billing/a credit card on the account.

CI (`.github/workflows/ci.yml`) runs on every push/PR to `main`:
typecheck + lint + domain/adapters pure-logic tests (~45s total).
Live-D1/db/api suites are manual-only (require live `CF_TOKEN` against shared resources — see zero-mocks policy in `AGENTS.md`).

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

This project is licensed under the **MIT License**.

- ✅ Free for personal, commercial, and open-source use
- ✅ Modify and distribute freely
- ✅ No warranty — use at your own risk

See [LICENSE](LICENSE) for full terms.

---

<!-- donation:eth:start -->
<div align="center">

## 💼 Support Development

If this project helps your work, support ongoing maintenance and new features.

**ETH Donation Wallet**  
`0x11282eE5726B3370c8B480e321b3B2aA13686582`

<a href="https://etherscan.io/address/0x11282eE5726B3370c8B480e321b3B2aA13686582">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=0x11282eE5726B3370c8B480e321b3B2aA13686582" alt="Ethereum donation QR code" width="220" />
</a>

_Scan the QR code or copy the wallet address above._

</div>
<!-- donation:eth:end -->

---

<!-- related-projects:start -->
## 🌐 Related Projects

More projects from the same author — not part of Hiring Signals, listed for discovery only:

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
<!-- related-projects:end -->

---

<!-- services:start -->
## 💼 Services Offered

- 🔍 **Hiring Intelligence Tools** — Signal detection, ATS integrations, hiring velocity analytics
- 🤖 **AI Agent Integration** — CLI-first tooling, structured JSON output, saved filter profiles for automated workflows
- 🚀 **Edge Computing Solutions** — Cloudflare Workers, D1, KV, Vectorize, Queue-based pipelines
- 🔒 **Privacy-First Development** — No personal data collection, hashed identifiers, zero-scraping architecture
- 🛡️ **Security Tool Development** — Burp extensions, penetration testing tools, MCP security servers
- 🔧 **Full-Stack TypeScript** — Hono APIs, pnpm monorepos, strict TypeScript, Zod validation

**Get in Touch**: [teycirbensoltane.tn](https://teycirbensoltane.tn) | Available for freelance projects and consulting
<!-- services:end -->

---

<!-- attribution:start -->
<div align="center">

**Built with 💚 by [Teycir Ben Soltane](https://teycirbensoltane.tn)**

</div>
<!-- attribution:end -->
