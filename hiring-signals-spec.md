# Hiring Signals Intelligence — Build Specification

> **Product:** A CLI-first tool, built for AI agents to query on a person's behalf, that surfaces genuine, matching IT job postings the moment they appear publicly — built for a job seeker who wants to see the opening before the rest of the crowd does. Decided with the user 2026-08-07: the real end-user is an AI agent invoking the CLI, not a human browsing a UI (see ROADMAP.md Milestone F.1).
>
> **Primary outcome:** detect a new, real, still-open job posting that matches the user's saved role/location filters within minutes-to-hours of it going live, and return it with full public evidence. Company-level hiring trends (bursts, acceleration) are kept as secondary context, not the primary product.
>
> **Optimization target:** speed-to-signal and long-run reliability over breadth of interpretation. The system is judged on (1) how soon after posting a matching job is queryable via the CLI, and (2) how long it runs unattended without breaking or requiring correction — not on how many analytical angles it can compute per company.
>
> **Delivery model:** pull-only. An agent invokes the CLI and gets results current as of the last successful poll. No push notifications, no email/webhook alerting, no interactive prompts. This is a deliberate simplicity choice: every delivery channel is a class of thing that can break silently, and none is worth the fragility for v1.
>
> **Deployment target:** Cloudflare Workers for the API and scheduled ingestion; the CLI (`apps/cli`) is a thin Node client over that API, run locally or invoked by an agent.
>
> **Design direction (API/CLI):** structured output by default (JSON), no interactive prompts, machine-readable errors, deterministic and scriptable — the same priorities as any tool built for a caller that can't respond to a stdin prompt.

---

## 1. Product framing

### 1.1 Problem

For a job seeker, the value of a job posting decays with the number of other applicants who have already seen it. Job boards and aggregators surface postings on their own schedule, often hours to days after the employer publishes them, and by the time a posting is trending or aggregated, the applicant pool has usually already formed. The addressable edge is **detection latency**: seeing a genuine, still-open, matching posting closer to the moment the employer published it, sourced directly from the employer's own public ATS rather than from a downstream aggregator.

The application converts public job-board changes into a role-level feed: "this specific posting, matching your saved filters, first observed at this time, still open as of the last check." Company-level hiring trends (bursts, acceleration) remain available as secondary context on a company page, but they are not the primary signal — a seeker acts on individual openings, not on an account's aggregate hiring pace. The system must never imply anything about a company's budget or intent; it reports observable public evidence only, and it must keep running unattended without silent breakage, since a fast feed that quietly stops updating is worse than a slow one that is honest about its own health.

### 1.2 Target users

| User                                   | Job to be done                                                                                                                   | Priority |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------: |
| Job seeker (IT specialist)             | See genuine, matching, still-open postings as soon as possible after they go live, with enough evidence to trust and act on them |       P0 |
| Job seeker, passive                    | Ask their AI assistant to check saved role/location filters periodically via the CLI, without needing to actively job-search daily | P0 |
| Administrator (may be the same person) | Manage source coverage, retention, and system health so ingestion keeps running without manual correction                        |       P1 |

_B2B sales/recruiting use of company-level signals is retained as a secondary, lower-priority audience (see §1.4) — it reuses the same ingestion pipeline but is not the product's design center._

### 1.3 Non-goals for v1

- No collection of private profiles, contact data, or personal data from social networks.
- No bypassing logins, CAPTCHAs, rate limits, robots directives, or anti-bot controls — speed is pursued through polling frequency and source breadth, never through evasive fetching. A source that requires evasion is disabled, not defeated.
- No general-purpose HTML scraping of arbitrary career pages. Coverage growth is spent on adding more _official, documented ATS APIs_, not on scraping fragile rendered pages — scraping is the more brittle path and works directly against the "set and forget, nothing breaks" requirement.
- No push notifications, email digests, or webhook alerting in v1. The CLI is pull-only; see the delivery model above.
- No automated sending of cold email, LinkedIn messages, or enrichment of individuals.
- No claims that a job posting represents a confirmed project, budget, or purchasing decision.
- No real-time stream guarantee; freshness is scheduled and source-dependent, but the schedule should be tight enough that "scheduled" and "real-time-ish" are not far apart in practice (see §5.2).

### 1.4 Definition of a hiring signal

Two signal families exist. The role-level signal is what the user sees first and most; the company-level signal is retained for context and for the secondary sales use case.

**Role-level (primary):**

- **New matching role:** a job matching the user's saved filters is first observed. This is the core product event.
- **Reopened role:** a previously closed or absent matching job reappears.
- **Still active:** a previously surfaced matching job remains open at the most recent successful check — useful so the user knows a listing they saw earlier hasn't disappeared.

**Company-level (secondary context, shown on the company page, not the main feed):**

- **Hiring burst:** $n$ or more matching jobs appear within a rolling window.
- **Demand acceleration:** recent matching-role volume exceeds the company's baseline.
- **Multi-location expansion:** one role family appears across multiple distinct locations.

Every signal shown to users must retain an evidence trail: source platform, canonical public URL, source job identifier, timestamps, title, location, department if available, and the rule that created it.

---

## 2. Scope and release plan

### 2.1 MVP / P0

1. Ingest jobs from a **wide** set of official, documented public ATS APIs (see §4.1 — breadth of official adapters is a P0 priority, not deferred).
2. Normalize companies, jobs, locations, and IT role categories.
3. Detect new-matching-role and reopened-role signals at the role level (primary); detect burst/acceleration at the company level (secondary context).
4. Persist snapshots and signal events in Cloudflare D1.
5. Provide a searchable, filterable signal list via the CLI (`hs signals list`), pull-only, current as of the last successful poll.
6. Filter by **role** and **location** as the primary axes for the job-seeker feed; filter by **company** as a secondary lens.
7. Provide a signal-detail command (`hs signals get <id>`) with public evidence links.
8. Provide CSV export of the currently filtered signal list.
9. Run scheduled ingestion via Cloudflare Worker cron triggers, on a **tight, per-provider adaptive cadence** (see §5.2) — this is the core lever for detection speed and is P0, not a later optimization.
10. The app itself has no login and is free/public for anyone to use — no authentication step in front of it, ever (see §10.5/§11.1).
11. Per-source health isolation: one broken/degraded adapter must never affect ingestion of any other source (see §10.4) — required for "set and forget" at a tighter polling cadence.

### 2.2 P1

- Saved role/location filter profiles (no alerting attached — just a saved CLI query).
- Company watchlists.
- Source-health interface as a local ops script (§10.5), not an in-app admin page.
- Manual company/source onboarding from a CSV.
- Role taxonomy editor and title-rule review queue.
- Change log showing why a signal or score changed.
- Trend charts on `/trends` — promoted out of §2.3 P2 and built 2026-08-19. `GET /api/v1/trends/hiring` (Milestone P.2, §9.2 endpoint table) was already returning ranked `HiringTrendCompany[]` rows; `apps/web`'s `TrendsChart` component (recharts, horizontal bar, top 8 by the active sort's metric) now renders that same response visually above the existing `TrendsTable`, no new endpoint. Source-coverage reporting (the other half of the original P2 line item below) stays deferred — this promotion covers trend charts only.

### 2.3 P2 (explicitly deferred, not part of this optimization)

- Any push delivery channel (email, Slack, webhook) — deliberately out of scope; see delivery model in the header and §1.3. Revisit only if the pull-only model proves insufficient in practice, and only with a robustness bar equal to the rest of the system.
- Integrations with a CRM through a server-side OAuth flow (secondary sales use case).
- Team annotations and dispositioning.
- Source-coverage reporting (which sources/providers are contributing how much signal volume, uptime, etc.) — still deferred. Trend charts, previously grouped with this line item, were promoted to §2.2 P1 and built 2026-08-19 (see above); that promotion does not extend to source-coverage reporting, which remains genuinely out of scope.
- Clearbit-like company enrichment or a reviewed generic career-page adapter — still excluded; scraping remains out of scope regardless of phase (see §1.3).

---

## 3. Architecture decision

### 3.1 Recommended topology

Use a split deployment: the CLI never does long-running ingestion itself.

```text
Agent / person's terminal
  │
  └── invokes ──> CLI (apps/cli, thin Node client)
                    │
                    └── HTTPS ──> Cloudflare Worker API /api/*
                                    ├── D1: canonical data, snapshots, signals
                                    ├── KV: cached filter metadata, rate-limit counters,
                                    │      and TTL-based raw source-response archive
                                    ├── Queues: ingestion jobs and retry isolation
                                    └── Cron Trigger: schedules discovery / reconciliation
```

### 3.2 Why this split is required

The scheduled ingestion service must be a dedicated Worker, because it needs cron execution, durable storage bindings, retries, rate limiting, and isolation from the CLI's request/response cycle. The CLI is used for composition of queries and results, not for crawling or holding secrets.

The delivery requirement remains: the CLI is a thin client, and a separate Worker owns ingestion, storage, and business logic. This keeps exactly one source of truth for business logic instead of duplicating it into the CLI (decided with the user 2026-08-07).

### 3.3 Monorepo layout

Use `pnpm` workspaces and TypeScript with strict mode enabled.

```text
hiring-signals/
├── apps/
│   ├── cli/                         # CLI, primary interface (decided with the user 2026-08-07)
│   │   ├── src/commands/
│   │   ├── src/lib/api-client.ts
│   │   └── package.json
│   └── api/                         # Cloudflare Worker, Hono recommended
│       ├── src/index.ts
│       ├── src/routes/
│       ├── src/services/
│       ├── src/jobs/
│       └── wrangler.toml
├── packages/
│   ├── domain/                      # Zod schemas, types, scoring constants
│   ├── adapters/                    # ATS adapter interface and implementations
│   └── db/                          # migrations and query helpers
├── infrastructure/
│   ├── d1/migrations/
│   └── scripts/
├── .github/workflows/
├── pnpm-workspace.yaml
└── README.md
```

### 3.4 Technology choices

| Area                           | Choice                                      | Reason                                                                                                                                                 |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI                             | Node.js, TypeScript                        | Thin client over the Worker API; JSON-by-default, no interactive prompts (decided with the user 2026-08-07)                                            |
| Validation                     | Zod                                         | Validate all API boundaries and source payloads                                                                                                        |
| API                            | Cloudflare Worker + Hono or native `fetch`  | Lightweight, Workers-native, typed middleware                                                                                                          |
| Primary database               | Cloudflare D1                               | Relational joins and filtering fit signals/jobs well                                                                                                   |
| Async work                     | Cloudflare Queues                           | Decouple scheduler from source fetching/retries                                                                                                        |
| Cache / counters / raw archive | Cloudflare KV                               | Filter metadata cache, rate-limit state, and TTL-based raw payload archive (no R2 -- avoids requiring Cloudflare billing/a credit card on the account) |
| Observability                  | Workers Analytics Engine + structured logs  | Query ingestion quality and operational failures                                                                                                       |

The product is public and free to use: no login, no accounts, no
per-user access control. Every data endpoint (`/api/v1/signals`,
`/api/v1/companies`, `/api/v1/facets`) is reachable
by anyone, unauthenticated, as its permanent operating mode -- not a
temporary demo posture ahead of an auth rollout. Source management
(adding/editing ATS sources, triggering a manual ingestion run, viewing
source health) is an operator task done directly against D1 via a local
script, not an HTTP surface exposed by the deployed Worker -- see §10.5.

---

## 4. Data sources and collection policy

### 4.1 Approved source categories

All P0 sources are official, documented ATS APIs. Breadth of coverage is pursued aggressively — every adapter below is P0, not staged across releases — because more official APIs means more chances to see a posting first. What is not negotiable is _how_ each source is collected: public, unauthenticated, documented endpoints only. Scraping rendered HTML is never in scope, at any phase, regardless of how much coverage it would add (see §1.3) — it is the one move that would trade real reliability for speed, which is the trade this product refuses to make.

| Adapter                                                                             | Typical public endpoint pattern                                                          | Collection method    |                   MVP status |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------- | ---------------------------: |
| Greenhouse                                                                          | `boards-api.greenhouse.io/v1/boards/{token}/jobs`                                        | Public board API     |                           P0 |
| Lever                                                                               | `api.lever.co/v0/postings/{site}?mode=json`                                              | Public posting feed  |                           P0 |
| Ashby                                                                               | `api.ashbyhq.com/posting-api/job-board/{board}`                                          | Public job-board API |                           P0 |
| SmartRecruiters                                                                     | `api.smartrecruiters.com/v1/companies/{id}/postings`                                     | Public postings API  |                           P0 |
| Workable                                                                            | Public jobs API                                                                          | API adapter          |                           P0 |
| Recruitee                                                                           | Public careers API                                                                       | API adapter          |                           P0 |
| Personio                                                                            | Public job postings API (where offered)                                                  | API adapter          |                           P0 |
| Any additional provider with a stable, documented, public JSON/REST job-listing API | To be confirmed per-provider at implementation time                                      | API adapter          | Add on demand, same contract |

**A previously supported adapter was removed 2026-08-18.** It shipped as a
full P0 adapter, but a production audit found its one live source no
longer had a live board at all -- the board URL 302-redirected to a
marketing homepage, not a job listing. The corresponding `sources` row
and its now-sourceless company were deleted from D1 rather than left to
degrade in place. Re-adding a provider under this scenario later is the
same well-scoped unit of work described below, should a working board
turn up.

**SmartRecruiters was considered for the same removal the same day
(also had only 1 live source) but was kept.** Its API was confirmed
live and returning real postings; the `consecutive_failures` on its
one source was a real, fixable adapter bug -- SmartRecruiters had
stopped including `actions.details`/`actions.apply` URLs in its list
response, and the adapter required one of those to build a
`canonicalUrl`. Fixed by synthesizing the canonical URL from
`posting.id`/`uuid` + the board token (`jobs.smartrecruiters.com/
{boardToken}/{postingId}`, confirmed to resolve) instead of requiring
it from the response.

Adding a new provider is a small, well-scoped unit of work precisely because every adapter obeys the same contract (§5.3): confirm the endpoint is public and documented, write the Zod schema for its payload shape, write the normalizer, write fixture tests. There is no legal-review gate blocking onboarding a new official API adapter in v1 — the trade-off in §1.3/§2.1 accepts that posture deliberately in exchange for speed of coverage. The technical courtesies in §4.3 (rate limits, `User-Agent`, backoff) remain mandatory regardless — they are what keeps a source from banning the product, which is a robustness requirement, not a legal one.

**If a provider's public API becomes unreliable, unstable, or disappears, disable that one adapter and show its source as degraded/disabled in the ops health script output (§13.2).** Never fall back to scraping that provider's rendered pages to compensate — a disabled source that clearly says so is more reliable, long-run, than a scraped one that silently breaks.

### 4.2 Source registry is curated, not discovered by uncontrolled crawling

The system needs an explicit registry of company job-board identities:

```json
{
  "companySlug": "acme-corp",
  "displayName": "Acme Corp",
  "domains": ["acme.example"],
  "sources": [
    {
      "provider": "greenhouse",
      "boardToken": "acme",
      "publicUrl": "https://boards.greenhouse.io/acme",
      "enabled": true,
      "pollIntervalMinutes": 90
    }
  ]
}
```

Initial registry population options:

1. Administrator imports a vetted CSV of target companies and known ATS board tokens.
2. Administrator adds sources via a local ops script (`infrastructure/scripts/add-source.mjs`).
3. A future discovery tool may propose candidates, but must require human review before polling.

This avoids unreliable company matching and prevents indiscriminate web collection.

### 4.3 Responsible collection requirements

- Fetch only public, unauthenticated endpoints allowed by the source.
- Use a clear `User-Agent` identifying the product and a support email/domain.
- Respect documented provider limits where a provider publishes one; where unspecified, the ceiling is set by the Cloudflare free-tier budget in §5.2, not by an arbitrary guess — see that section for the derivation.
- Per-provider concurrency: default $2$; tune only with measured success and provider guidance.
- Apply exponential backoff with jitter on $429$ and $5xx$ responses.
- Honor `Retry-After` whenever present.
- Do not circumvent access restrictions; immediately disable adapters returning anti-bot/CAPTCHA responses.
- Store the minimum raw data needed for debugging. Avoid storing applicant data even if accidentally present.
- Retain raw payloads for $30$ days by default; retain normalized business records per product retention policy.
- Show source attribution and a link to the canonical job post in the output.

### 4.4 Secrets and public configuration

No API credential belongs in browser code, static environment variables, Git history, logs, screenshots, or error responses.

| Value                                                   | Storage                                   | Exposure                   |
| ------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| Worker secrets, webhook signing keys, CRM OAuth secrets | Cloudflare Worker secrets                 | Server only                |
| Database/KV/Queue bindings                              | `wrangler.toml` binding references        | Worker runtime only        |
| `HIRING_SIGNALS_API_BASE_URL`                            | CLI env var or `--api-base` flag          | Public by design; URL only |
| Feature flags with no sensitive value                   | Worker config                             | May be public              |

Use `wrangler secret put NAME` for secrets. Use `.dev.vars` only locally and add it to `.gitignore`. Validate server environment values at Worker startup with Zod, but never return validation detail containing secret names/values to clients.

---

## 5. Ingestion pipeline

### 5.1 Flow

```text
Cron event
  → identify due source records
  → enqueue one message per source
  → Queue consumer fetches provider endpoint
  → validate provider payload
  → normalize into canonical job records
  → upsert jobs and insert observations
  → compute state transitions / signals
  → write raw response pointer and source-run metrics
  → cache facets summary invalidation
```

### 5.2 Scheduling — cadence is computed from the Cloudflare free-tier budget, not guessed

The whole point of this rework is detection latency, so cadence should be as tight as possible — but "as tight as possible" has a hard ceiling on the Workers Free plan, and blowing through it (Error 1027 on requests, hard failures on Queues/D1 once the daily allowance is spent) is exactly the kind of silent breakage the "set and forget" requirement rules out. The cadence is therefore derived from the account's actual free-tier limits, verified against Cloudflare's published limits (last confirmed **July 2026**; re-check `developers.cloudflare.com/workers/platform/limits` and the D1/Queues limits pages before relying on these numbers, since Cloudflare revises them):

| Resource                   | Free-tier daily allowance                                       | What consumes it here                                                                                                    |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Workers requests           | $100{,}000$/day                                                 | Cron fires + Queue consumer invocations + every CLI invocation/API call                                                  |
| Queues operations          | $10{,}000$/day (send + receive + delete combined)               | One enqueue + one dequeue per source-fetch attempt, plus retries                                                         |
| D1 rows written            | $100{,}000$/day                                                 | Job upserts, observation inserts, signal inserts                                                                         |
| D1 rows read               | $5{,}000{,}000$/day                                             | Read-path queries (signals/companies/facets) — not the binding constraint here                                          |
| Cron Triggers              | $3$ per Worker, $5$ per account, $1$-minute minimum granularity | The scheduler itself; cheap regardless of frequency since it only enqueues, it doesn't fetch                             |
| Subrequests per invocation | $50$/invocation (Free)                                          | Caps how many boards one Queue consumer invocation can fetch before it must stop and let the next message batch continue |

**The binding constraint is Queues, not the cron granularity.** A 1-minute cron is affordable on its own (1,440 fires/day, each a cheap "find due sources" query); what's expensive is what each fire causes downstream. Each source poll costs roughly 2 Queue operations (one enqueue, one dequeue; retries add more). Keeping a safety margin at 70% of the daily Queues allowance ($7{,}000$ ops/day, leaving headroom for retries, manual admin-triggered polls, and the daily health check) gives:

$$
T_{\text{minutes}} \;\geq\; \frac{1440 \times N_{\text{sources}}}{3500}
$$

where $N_{\text{sources}}$ is the number of enabled sources and $T$ is the per-source polling interval in minutes. Concretely:

| Enabled sources | Minimum safe interval (formula) | Recommended default |
| --------------: | ------------------------------: | ------------------: |
|              50 |                         ~21 min |          **30 min** |
|             150 |                         ~62 min |          **90 min** |
|             300 |                        ~123 min |         **2 hours** |
|             600 |                        ~247 min |         **4 hours** |

Rules that follow from this:

- **Cadence is a computed, monitored value, not a fixed constant in code.** The Worker must track $N_{\text{sources}}$ (count of enabled sources) and the rolling daily Queues operation count, and the admin health page (§13.2) must surface both alongside the currently effective interval. If actual usage approaches 85% of the daily Queues or D1-write allowance, the system should widen the interval automatically rather than silently start failing enqueues — this is what keeps "set and forget" true as source count grows over time.
- **Default at MVP launch (assume ~100–150 seed sources): 60–90 minutes per source**, computed from the table above rather than picked arbitrarily. This is already a large improvement over the original 6-hour default and is the honest, sustainable version of "minutes-to-hours" on a free-tier budget.
- **If the user is willing to move to the $5/month Workers Paid plan, cadence can drop substantially** (no daily request cap, Queues/D1 paid allowances are far larger) — worth flagging as a low-cost upgrade path if true near-real-time detection becomes the priority later. This is not required for v1 but should be a documented, easy switch (see §19 open decisions).
- No separate "high-priority watchlist" tier at a tighter cadence in v1 — a second tier doubles the moving parts (two schedules to keep within budget, two things that can silently drift) for a benefit that a single well-computed default already delivers. Reconsider only after the single-tier system has run unattended and clean for a while.
- Reconciliation: once daily, re-check jobs considered active but not seen recently, on the same Queues/D1 budget (accounted for in the 70% margin above).
- Source health check: once daily for all enabled sources, folded into the same budget.
- Use deterministic jitter calculated from `source_id` so sources don't all fire in the same cron tick and spike subrequest usage past the per-invocation cap.

A cron handler must only find due work and enqueue messages. It must not sequentially fetch hundreds of boards in one invocation — that both blows the 10 ms Free-tier CPU-per-cron-invocation limit and defeats the whole point of decoupling scheduling from fetching via Queues.

### 5.3 Adapter contract

Every provider adapter must implement the same pure, testable contract:

```ts
export interface AtsAdapter {
  provider:
    | "greenhouse"
    | "lever"
    | "ashby"
    | "smartrecruiters"
    | "workable"
    | "recruitee"
    | "personio";
  fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult>;
  normalize(raw: unknown, source: SourceConfig): NormalizedJob[];
}

export interface NormalizedJob {
  externalJobId: string;
  canonicalUrl: string;
  title: string;
  descriptionText?: string;
  department?: string;
  employmentType?: string;
  locationRaw?: string;
  locationMode?: "remote" | "hybrid" | "onsite" | "unknown";
  postedAt?: string;
  updatedAt?: string;
  requisitionId?: string;
}
```

Requirements:

- Validate raw responses with provider-specific Zod schemas before normalization.
- Preserve source identifiers exactly; do not manufacture IDs from titles.
- Use a unique job key of `$source_id + external_job_id$`.
- Canonicalize strings for matching but keep raw values for display/audit.
- Capture a deterministic normalized-content hash to detect edits.
- Treat missing dates as unknown, not as current.

### 5.4 Job lifecycle rules

A listing state is based on repeated observations, not a single missing fetch.

| Condition                                                    | Result                                          |
| ------------------------------------------------------------ | ----------------------------------------------- |
| Job seen for first time                                      | `active`, emit `new_job` candidate              |
| Job seen and hash changed                                    | update record, create `job_changed` audit event |
| Job absent from one successful source run                    | increment missing count; remain active          |
| Job absent from $2$ consecutive successful runs              | mark `possibly_closed`                          |
| Job absent from $4$ consecutive successful runs or $14$ days | mark `closed`                                   |
| Job returns after closure                                    | mark `active`, emit `reopened_job` candidate    |
| Source run fails                                             | do not alter missing counts                     |

The exact thresholds must be configuration, not hard-coded. The API/CLI must not show a “closed” assertion when source availability is uncertain.

---

## 6. Normalization and taxonomy

### 6.1 Canonical role categories

P0 role categories:

- Software Engineering
- Data Engineering / Analytics
- Cloud / Platform / DevOps / SRE
- Cybersecurity
- IT Support / Help Desk
- Systems / Network Administration
- QA / Test Automation
- Product / Technical Program Management
- ERP / Business Systems
- AI / Machine Learning

A job can map to multiple categories with confidence levels. For filtering, use the highest-confidence primary category plus optional secondary tags.

### 6.2 Classification approach

Use deterministic rules first. Do not make an LLM dependency necessary for the ingestion pipeline.

1. Normalize title: lowercase, Unicode normalize, strip punctuation, collapse whitespace.
2. Match high-precision phrase rules, e.g. `site reliability engineer` → `cloud_platform_devops_sre`.
3. Match approved abbreviations, e.g. `sre`, `soc`, `iam`, `etl`.
4. Apply negative terms to prevent false positives, e.g. `security guard` must not map to cybersecurity.
5. Optionally inspect department and description only when title confidence is low.
6. Write classification version and confidence to the job record.
7. Send ambiguous items to a review queue rather than overstating certainty.

Example scoring for rule confidence:

$$
C_{role} = 0.70C_{title} + 0.20C_{department} + 0.10C_{description}
$$

Only classify automatically when $C_{role} \geq 0.80$. The thresholds must be configurable and tested using a labeled fixture set.

### 6.3 Company identity

The canonical company is created by an administrator or import process. Do not infer company identity solely from a job-board name. Maintain aliases and domains.

- `company.slug` is immutable after creation.
- `company.display_name` is user-facing and editable.
- `company.domain` is optional but strongly recommended.
- Each job-board source belongs to exactly one company.
- Mergers and rebrands are handled using aliases and a manually reviewed relationship table.

### 6.4 Location normalization

Store the raw source location and a normalized record where possible:

- Country code using ISO $3166-1$ alpha-$2$.
- Region/state code only where confidently parsed.
- City as source text plus normalized city when supported.
- Work mode: `remote`, `hybrid`, `onsite`, `unknown`.

Never discard source text. A remote role should not be assumed globally remote; display qualifiers such as “Remote — US” when supplied.

---

## 7. Signal model and scoring

### 7.1 Signal types

| Type                | Trigger                                                  | User-facing statement                 |
| ------------------- | -------------------------------------------------------- | ------------------------------------- |
| `new_job`           | Matching job first observed                              | “New matching role observed”          |
| `reopened_job`      | Closed job becomes active                                | “Role reopened”                       |
| `hiring_burst`      | At least $3$ new matching jobs within $14$ days          | “Cluster of new matching roles”       |
| `role_acceleration` | Recent role volume materially exceeds baseline           | “Hiring pace above recent baseline”   |
| `multi_location`    | Matching roles active in at least $3$ distinct locations | “Role family active across locations” |
| `persistent_demand` | Same category remains active over $30$ days              | “Sustained public demand”             |

### 7.2 Score design

A score ranks review priority; it is not a probability that outreach will convert.

Use a bounded score from $0$ to $100$:

$$
S = \min\left(100,\; 35R + 25V + 20A + 10B + 10Q - P\right)
$$

Where:

- $R$: freshness score from $0$ to $1$ based on observation age.
- $V$: matching active-role volume score from $0$ to $1$.
- $A$: acceleration score from $0$ to $1$.
- $B$: breadth score from location/team diversity, from $0$ to $1$.
- $Q$: data-quality / role-classification confidence, from $0$ to $1$.
- $P$: penalties for stale listings, duplicate patterns, or low source reliability.

Freshness can use exponential decay:

$$
R = e^{-d / 14}
$$

where $d$ is the number of days since the signal’s most recent evidence observation.

For acceleration, compare the most recent $14$ days to the preceding $56$ days, normalized to an expected $14$-day count:

$$
A = \operatorname{clamp}\left(\frac{N_{14} - \frac{N_{56}}{4}}{\max(2, \frac{N_{56}}{4})}, 0, 1\right)
$$

Requirements:

- Store every component score, formula version, and inputs in `signal_evidence`.
- Scores must be recomputable from persisted observations.
- Never hide low-confidence evidence; label it clearly.
- A user should be able to answer “why is this ranked $82$?” from the signal detail output.

### 7.3 Deduplication

Prevent the system from counting the same opening repeatedly.

1. **Hard duplicate:** same `$source_id + external_job_id$` — upsert one job.
2. **Likely duplicate within a company:** same normalized title, same location mode/location, and same requisition identifier if available.
3. **Similar jobs:** preserve separately when source IDs differ, but group in output as “$3$ similar openings” when title similarity and department match exceed a threshold.
4. Do not deduplicate across companies unless an administrator has marked a parent/subsidiary relationship.

---

## 8. Database design

### 8.1 Storage responsibilities

| Store | Contents                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | normalized relational data, source runs, jobs, observations, signals, users                                                                    |
| KV    | cached role/company facets, short-lived response cache, rate-limit counters, TTL-based raw source-response archive, TTL-based export artifacts |
| Queue | source-fetch work, optional export generation jobs                                                                                             |

### 8.2 D1 schema outline

```sql
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  employee_band TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  provider TEXT NOT NULL,
  board_token TEXT NOT NULL,
  public_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
  next_poll_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, board_token)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  external_job_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title_raw TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  description_text TEXT,
  department_raw TEXT,
  employment_type TEXT,
  location_raw TEXT,
  location_mode TEXT NOT NULL DEFAULT 'unknown',
  country_code TEXT,
  region_code TEXT,
  city TEXT,
  role_primary TEXT,
  role_tags_json TEXT NOT NULL DEFAULT '[]',
  classification_confidence REAL,
  classification_version TEXT,
  posted_at TEXT,
  source_updated_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_run_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL,
  UNIQUE(source_id, external_job_id)
);

CREATE TABLE job_observations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  source_run_id TEXT NOT NULL REFERENCES source_runs(id),
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  is_present INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  jobs_received INTEGER,
  jobs_normalized INTEGER,
  error_code TEXT,
  error_message_safe TEXT,
  raw_payload_key TEXT,
  duration_ms INTEGER
);

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  role_category TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  score INTEGER NOT NULL,
  score_version TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  expires_at TEXT,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE signal_evidence (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES signals(id),
  job_id TEXT REFERENCES jobs(id),
  evidence_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_jobs_filters
  ON jobs(company_id, role_primary, status, last_seen_at DESC);
CREATE INDEX idx_signals_feed
  ON signals(status, role_category, score DESC, last_detected_at DESC);
CREATE INDEX idx_source_due
  ON sources(enabled, next_poll_at);
```

### 8.3 Data retention

- Job observations: retain $180$ days initially.
- Source-run metrics: retain $180$ days.
- Raw payloads in KV: retain $30$ days via `expirationTtl`, then auto-expire (see apps/api/src/services/raw-payload-store.ts).
- Closed job records: retain $365$ days to support reopening and trend baselines.
- Signals: retain $365$ days; inactive signals remain queryable in history but are excluded from the default feed.
- Export artifacts: expire after $24$ hours (KV `expirationTtl`).

Retention settings must be centralized, documented, and automated with scheduled cleanup.

---

## 9. API contract

### 9.1 General conventions

- Base path: `/api/v1`.
- All responses use JSON and have a stable envelope.
- All data endpoints are public and unauthenticated (§11.1) — no auth check anywhere in the request path.
- Return `requestId` in success and error responses.
- Cursor pagination for signal lists; do not use offset pagination on large tables.
- Validate query parameters using Zod.

Success envelope:

```json
{
  "data": {},
  "meta": { "requestId": "req_..." }
}
```

Error envelope:

```json
{
  "error": {
    "code": "INVALID_FILTER",
    "message": "One or more filters are invalid.",
    "requestId": "req_..."
  }
}
```

### 9.2 Endpoints

| Method  | Route                         | Purpose                                          |
| ------- | ----------------------------- | ------------------------------------------------ |
| `GET`   | `/api/v1/signals`             | Paginated, filtered feed                         |
| `GET`   | `/api/v1/signals/:signalId`   | Signal detail and evidence                       |
| `GET`   | `/api/v1/companies`           | Company autocomplete / filter facets             |
| `GET`   | `/api/v1/companies/:slug`     | Company detail and recent signals                |
| `GET`   | `/api/v1/companies/:slug/jobs` | Raw per-job listing for one company (new -- see §9.3a) |
| `GET`   | `/api/v1/companies/:slug/timeline` | One company's own hiring history, bucketed new/closed/active jobs (Milestone O.1) |
| `GET`   | `/api/v1/companies/:slug/role-activity` | One company's new/active job counts for one role, over 7/30/90-day windows (Milestone V.4) |
| `GET`   | `/api/v1/jobs/:jobId`         | Single raw job posting, full detail (new)        |
| `GET`   | `/api/v1/facets`              | Role, company, source, location counts           |
| `GET`   | `/api/v1/trends/hiring`       | Cross-company hiring trend ranking, powers `/trends`'s table and chart (Milestone P.2, §2.2's trend-charts promotion) |
| `GET`   | `/api/v1/export/signals.csv`  | Server-generated CSV of the current filtered query |

`GET /api/v1/sources` is also public/unauthenticated — a read-only
listing (source, provider, company) alongside the table above, same
rate-limit tier as every other route here.

`/api/v1/admin/*` (spec §10.5a) is the one exception: an
**operator-only, secret-gated** surface, never reachable from any
user-facing flow, and never a login a user sees. It exists to
trigger the same pipelines the cron already runs (source ingest,
scheduler flush, reconciliation) without shell access to `wrangler`; it
creates no capability the local ops scripts (§10.5) don't already have,
and it never touches read-path data or pricing — the product has no
paywall, full stop. Source *write* management (add/edit a source) still
lives only as a local ops script, not this route or any other.

### 9.3 Signal list query

Example:

```text
GET /api/v1/signals?roles=cybersecurity,cloud_platform_devops_sre&company=acme&minScore=60&observedSince=2026-07-12&sort=score_desc&limit=50
```

Allowed fields:

| Parameter       | Type                 | Notes                                                 |
| --------------- | -------------------- | ----------------------------------------------------- |
| `roles`         | comma-delimited enum | Primary role categories                               |
| `company`       | string               | Slug, exact ID, or server-side autocomplete selection |
| `q`             | string               | Company-name search; minimum $2$ characters           |
| `like`          | string               | Job id for id-based similarity (§9.4 capability 3); wins over `q` if both are present |
| `locationMode`  | enum                 | `remote`, `hybrid`, `onsite`, `unknown`               |
| `country`       | ISO code             | Optional                                              |
| `source`        | provider enum        | Optional                                              |
| `signalType`    | enum                 | Optional                                              |
| `minScore`      | integer $0$–$100$    | Default $0$                                           |
| `observedSince` | ISO date             | Default last $30$ days                                |
| `sort`          | enum                 | `score_desc`, `newest`, `company_asc`                 |
| `cursor`        | opaque string        | Pagination cursor                                     |
| `limit`         | integer $1$–$100$    | Default $50$                                          |

The API must build parameterized SQL. Never concatenate raw query text into SQL.

### 9.3a Company jobs list query (new)

`GET /api/v1/companies/:slug/jobs` -- the raw per-job listing signals
never exposed (signals are derived events over jobs, not the jobs
themselves; a job below the scoring threshold, or in a role category
with no matching saved filter, still shows up here). `company` is the
`:slug` path param, not a query field; everything else mirrors §9.3's
shape/defaults/error behavior.

Example:

```text
GET /api/v1/companies/acme/jobs?roles=cybersecurity&locationMode=remote&status=active&sort=newest&limit=50
```

Allowed fields:

| Parameter      | Type                 | Notes                                          |
| -------------- | -------------------- | ----------------------------------------------- |
| `roles`        | comma-delimited enum | Primary role categories (`role_primary`)        |
| `locationMode` | enum                 | `remote`, `hybrid`, `onsite`, `unknown`         |
| `status`       | enum                 | `active`, `possibly_closed`, `closed`; default `active` |
| `sort`         | enum                 | `newest`, `oldest`, `title_asc`                 |
| `cursor`       | opaque string        | Pagination cursor                               |
| `limit`        | integer $1$–$100$    | Default $50$                                    |

`GET /api/v1/jobs/:jobId` returns the same job shape plus every field
the list view omits (`descriptionText`, `locationRaw`, `roleTags`,
`classificationVersion`, `sourceUpdatedAt`, `missingRunCount`) and an
`observationCount` derived from `job_observations`, so a caller can see
how many times a posting has actually been confirmed present without a
separate evidence lookup.

### 9.4 Semantic search (draft — added 2026-07-29, not yet built; see `ROADMAP.md` Milestone I)

This section is a draft addendum, written before implementation, per
this document's own role as the source of truth for behavior (`AGENTS.md`:
"Source of truth for behavior is always `hiring-signals-spec.md`").
Nothing below is built yet — `ROADMAP.md` Milestone I tracks the
build-out task by task and must not be treated as settled behavior
until this section is promoted out of draft status.

**Two capabilities, staged:**

1. **Free-text search over signals** (P0 for this addendum) — an
   upgrade to the existing `q` parameter (§9.3), which today only
   matches on company name. `q` is extended to also match job
   title/description/role content by meaning, not just substring, so a
   query like "remote rust backend" can surface a matching signal even
   when none of those exact words appear in the company name. This is
   an **additive** capability layered onto the existing keyword path,
   not a replacement — a plain company-name substring match must keep
   working exactly as it does today even if the semantic leg is
   degraded or unavailable (see the availability requirement below).
2. **Classification assist** (P1, explicitly deferred — see the
   guardrail below and `ROADMAP.md` I.5) — semantic similarity as an
   additional, optional input to §6.2's classification confidence
   scoring, never a replacement for it.
3. **Id-based "similar signals" lookup** (added 2026-08-19, promoted out
   of the "future revision" placeholder the query contract below
   originally left for it) — a dedicated `like` parameter (§9.3's
   table) that resolves nearest neighbours from a *specific signal's own
   representative job vector* via `VECTORIZE.getByIds`, rather than
   re-embedding free text through capability 1's `q` leg. This is the
   "more precise v2" `more-like-this-button.tsx`'s original header
   comment already anticipated: capability 1's `q` leg has no upper
   bound on input length (a signal headline can run well past what a
   search box would ever contain), and is the wrong mechanism for "find
   more like this specific thing" even where it works, since it
   similarity-matches on a re-embedded headline's wording rather than
   the job's actual stored embedding.

**Guardrail (binding on all three capabilities, restated from §18):**
_"Do not use a generic 'AI classifier' where deterministic rules are
enough. Make any model-assisted classification opt-in, server-side,
auditable, and non-blocking."_ Concretely for this feature:

- §6.2's deterministic classification pipeline (phrase rules,
  abbreviation matching, negative-term guards, the $C_{role}$ formula)
  remains the only path that can set `role_primary` and
  `classification_confidence`. Semantic similarity may only ever
  *nudge* an already-computed confidence score inside an existing
  low-confidence disambiguation path (§6.2 step 5) — it can never be
  the sole basis for auto-classifying a job, and it can never be a
  precondition for a job being classified at all.
- Job ingestion, normalization, and classification must all succeed
  identically whether or not Workers AI or the Vectorize index is
  reachable at that moment. An embedding-generation failure is logged
  and the job proceeds fully classified/scored/persisted through the
  existing deterministic path — it is never a reason to fail, retry, or
  degrade the ingestion pipeline (contrast with an ATS-fetch failure,
  which does retry per §10.4; embedding failure does not lose the job,
  only the job's searchability-by-meaning until a later backfill).
- Both capabilities are read-path / search-time and post-classification
  by construction — neither one can move earlier than "the job already
  has a `role_primary` (or `null`, per §6.2 step 7) and is already
  persisted."

**Query contract (free-text search, capability 1):** the `q` parameter's
type in §9.3's table does not change (`string`, still company-name
matched as today) — its *implementation* gains a second, semantic leg
run in parallel with the existing match and merged by score, the same
`data`/`meta` response envelope as every other `/api/v1/signals`
response (§9.1). A query that returns only a semantic match (no
company-name substring hit) is a legitimate, expected result once this
ships, not a bug.

**Query contract (id-based similarity, capability 3):** a new `like`
parameter on `GET /api/v1/signals` (added to §9.3's table alongside
`q`), type `string`, holding a `jobs.id` value — specifically, one of
the requesting signal's own `signal_evidence.job_id` values (schema at
line ~625; a client resolves this from `GET /api/v1/signals/:signalId`'s
(§9.2) `evidence[].jobId` field, not from any new field this section
adds). `like` and `q` are mutually
exclusive in the same request: if both are present, `like` wins and `q`
is ignored (rather than erroring on an ambiguous request — the same
"accept and resolve, don't 400 over it" posture the rest of §9.3 already
takes toward redundant/overlapping filters). When `like` is present:

- The keyword (`listSignals`) leg does not run at all — capability 3
  is a pure Vectorize lookup, not a hybrid merge like capability 1.
  `roles`/`company`/`locationMode`/`country`/`source`/`signalType`/
  `minScore`/`observedSince`/`sort`/`cursor` are all ignored when `like`
  is present (mirrors ArxivExplorer's `handleMoreLikeThis`, which takes
  no filters either) — a future revision may thread the non-`q` filters
  through if a concrete need for "similar roles, but only remote"
  emerges, but that's out of scope here per this section's own
  "must be added here first" rule below.
- The server resolves the job id's own stored vector via
  `VECTORIZE.getByIds([jobId])`, queries nearest neighbours from that
  vector (not a re-embedded text query), excludes the source job id
  from the result set, then resolves the neighbour job ids back to
  active signals via the same `findSignalsByJobIds` capability 1's
  semantic leg already uses (§9.4 I.3) — so a `like` result is still
  drawn only from real, currently-active, fully-evidenced signals, not
  a raw Vectorize metadata snapshot.
- `meta.searchMode` (§9.1's response envelope) is `"similar"` for a
  `like` request, distinct from `"keyword"`/`"hybrid"` (capability 1),
  so a client can tell the three modes apart without inspecting which
  request param it sent.
- If the job id has no stored vector (never embedded, or embedded after
  this signal's evidence was captured — §9.4's own availability
  guardrail already establishes that embedding is best-effort, not
  guaranteed for every job), the response is a 404 with a structured
  error body (§9.1's error envelope), not a silent empty result — unlike
  capability 1's semantic leg, which degrades silently to keyword-only
  because a `q` search is expected to always return *something*
  reasonable, a `like` request found nothing to compare against, which
  is a genuinely different, worth-surfacing condition, not "zero
  matches."
- Same never-throw-past-this-boundary posture as capability 1's
  `findSemanticSignalMatches` for the neighbour-lookup step specifically
  (a Vectorize `query()` failure after a successful `getByIds` still
  degrades to an empty match list, not a 500) — but `getByIds` itself
  returning nothing IS the 404 case above, not a degrade-to-empty case,
  since that's the one failure mode with a genuine, useful answer to
  give the caller ("this job was never embedded") rather than papering
  over it.

If a future revision needs an explicit "semantic-only" or "paste text
to search" mode beyond what `q` and `like` now cover, it must be added
here first as its own named parameter before being implemented
(`ROADMAP.md` I.4 already flags a paste-text mode as an optional,
lower-priority follow-on, not in scope for this section).

**Non-goals for this addendum:**

- Embedding backfill specifically stays a local ops script calling
  Workers AI/Vectorize directly (§10.5's pattern), not a new admin
  route added just for this feature — I.3's backfill doesn't need
  `/api/v1/admin/*`'s pipeline-trigger capability (§10.5a) and
  shouldn't grow the admin surface's scope beyond what §10.5a already
  documents. This is a scoping note for I.3, not a blanket ban on
  admin routes generally — that ban was narrowed to a documented
  exception in §10.5a; read that section for the current rule.
- No change to what evidence is required to display a signal (§1.4's
  closing paragraph) — a semantically-matched result still needs the
  full evidence trail like every other signal; semantic matching only
  changes *which* signals a query surfaces, not what's shown once
  surfaced.
- No guarantee of semantic-match explainability in v1 (e.g. "matched
  because of X") — out of scope until there's a concrete UX need for
  it; note it here as a known gap rather than silently deciding against
  it.

---

## 10. Worker implementation requirements

### 10.1 Bindings

Illustrative `wrangler.toml` design:

```toml
name = "hiring-signals-api"
main = "src/index.ts"
compatibility_date = "2026-07-26"

[[d1_databases]]
binding = "DB"
database_name = "hiring-signals"
database_id = "<non-secret-id>"

[[kv_namespaces]]
binding = "CACHE"
id = "<non-secret-id>"

[[queues.producers]]
binding = "INGEST_QUEUE"
queue = "hiring-signals-ingest"

[[queues.consumers]]
queue = "hiring-signals-ingest"
max_batch_size = 10
max_batch_timeout = 30

[triggers]
crons = ["*/15 * * * *"]
```

Note: this cron only runs the "find due sources and enqueue" step (§5.1) — it fires every 15 minutes cheaply because it does a lightweight D1 query and enqueues nothing on ticks where no source is due yet. The actual per-source polling frequency is the `pollIntervalMinutes` value on each source record, computed per §5.2, not this cron's own tick rate. Keeping the two decoupled is what lets the scheduler be responsive (checks every 15 min so a source becoming due doesn't wait long) without the _Queues_ budget being spent on ticks that find nothing due.

Use the active Cloudflare configuration format at implementation time. Do not commit secrets to this file.

### 10.2 Worker routes and middleware

Middleware order:

1. Request ID generation.
2. Security headers and permissive CORS (see note below — no longer an access control now that the only caller is the CLI).
3. Per-IP rate limit (no auth step -- every route is open-access, see §10.5).
4. Zod validation.
5. Route handler.
6. Structured error mapping.
7. Structured log with safe fields only.

CORS is no longer a meaningful access control now that the only caller is the CLI (a Node process, not a browser) — it can be left permissive or removed. It is not a substitute for authentication if one is added later.

### 10.3 Queue message design

```ts
interface IngestMessage {
  version: 1;
  sourceId: string;
  runId: string;
  requestedAt: string;
  attempt: number;
}
```

The consumer must be idempotent. A retry for the same `$sourceId + runId$` must not create duplicate observations or duplicate signals. Use database transaction boundaries appropriate to D1 capabilities and stable unique keys.

### 10.4 Failure handling

| Failure                   | Response                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| $429$ / `Retry-After`     | Requeue after indicated/conservative delay; record rate-limit event |
| transient $5xx$ / timeout | Retry with capped exponential backoff                               |
| $4xx$ configuration issue | Mark source degraded; no automatic hammering                        |
| schema mismatch           | Store safe diagnostic, mark adapter warning, alert admin            |
| anti-bot / CAPTCHA        | Disable source automatically and notify admin                       |
| D1/KV temporary error     | Retry queue message; preserve idempotency                           |

Maximum retry count should be configured, e.g. $5$. After exhaustion, send to a dead-letter queue or persistent failure table with a human-review workflow.

### 10.5 Source management (ops-only, not an HTTP surface)

The product has no login and no admin UI in the deployed app. Adding a
source, editing a source's schedule/enabled flag, and triggering a
manual ingestion run are operator tasks performed by running a local
script against the target D1 database (`infrastructure/scripts/`),
the same way seed data (§17 Phase 0 step 5) is loaded. This keeps the
Worker's only routes as the public, unauthenticated read API -- there is
no state-changing endpoint reachable over the internet, so there is
nothing that needs CSRF protection, session auth, or a CAPTCHA gate.

Viewing source health (per-source last success/failure, next poll,
job counts -- the table shape in §13.2) is likewise a local query/script
against D1, not a `/admin/health` HTTP route.

If a future need justifies bringing source management back into the
deployed app (e.g. multiple people need to manage sources without shell
access to the Cloudflare account), that reopens the access-control
question this section currently closes -- treat it as a new decision,
not a default reversion to Cloudflare Access.

### 10.5a Operator-triggered pipeline runs (`/api/v1/admin/*`, decided 2026-07-30)

The decision above (no HTTP admin surface) covered *source write
management* specifically -- add/edit a source, change its schedule.
This subsection is the "new decision" that §10.5 said would be needed
if an operational need arose: triggering the pipelines the cron already
runs (one source's ingest, a scheduler flush, reconciliation)
on-demand, without shell access to `wrangler d1 execute`.

This does **not** reopen or weaken §11.1's core rule -- the product
remains public, free, no paywall, no login a user ever sees, forever.
`/api/v1/admin/*` is reachable only with a secret (`ADMIN_SECRET`, a
Worker secret, never a browser-visible value) via `Authorization:
Bearer <secret>`; no user-facing surface calls it or ever will —
`apps/web` (which never referenced `/admin`) was deleted 2026-08-07,
and `apps/cli` (Milestone F.1), once built, is a thin client over the
public read routes only. It is an operator convenience layered *next
to* the public API, not a gate in front of it.

Routes (`apps/api/src/routes/admin.ts`):

- `POST /api/v1/admin/sources/:sourceId/run` -- enqueue one source's
  ingest immediately, bypassing its poll schedule. Enqueues only, same
  as the scheduler (spec §5.2's "never fetch" rule still applies).
- `POST /api/v1/admin/scheduler/flush` -- run the due-source enqueue
  pass out-of-band (same function the 15-minute cron calls).
- `POST /api/v1/admin/reconcile` -- run the daily stale-signal score
  recompute out-of-band (same function the daily cron calls).

None of these create new capability -- each is a remote trigger for a
pipeline that already exists and already runs unattended on its own
cron. The only thing this section adds is *on-demand* triggering for an
operator who doesn't want to wait for the next tick or reach for
`wrangler`.

Abuse protection for this surface (`apps/api/src/middleware/admin-auth.ts`),
modeled on ArxivExplorer's own hardened admin pattern (same account,
proven in production):

1. Fail-closed: if `ADMIN_SECRET` is unset, every admin route returns
   403 regardless of what's sent -- there is no way to accidentally
   deploy this open.
2. `crypto.subtle.timingSafeEqual` comparison, never `===`, so a wrong
   guess can't be narrowed via response-time side channels.
3. Per-IP strike counter (SHA-256-hashed IP as the KV key -- raw IPs
   never appear in a key string) in the `ABUSE_LOGS` KV namespace
   (separate from `CACHE`/`RAW_PAYLOADS` so an IAM policy can scope
   abuse-log read access independently).
4. 3-strike / 60-second lockout on repeated failures.
5. Every auth event (success, wrong secret, lockout, secret-unset) is
   fire-and-forget audit-logged, never blocking the response.

This is strictly *more* hardened than the equivalent surface on the
sibling ArxivExplorer project, not a weaker imitation of it -- see that
project's `src/api-worker/routes/admin.ts` for the pattern this was
modeled on and improved on (that version uses a flat per-IP KV counter
without the hashed-key or fail-closed-on-unset properties).

Write-scope note: admin auth is a *gate*, not a bypass. Every repo-level
write these routes trigger still goes through the same
company-scoped/IDOR-safe queries as everywhere else in the app -- an
admin route enqueuing a source-run cannot touch data outside that
source's own company, same as if the cron had triggered it.

---

## 11. Security, privacy, and compliance

### 11.1 Security controls

- All data APIs are intentionally public and unauthenticated -- this is
  the permanent operating mode, not a temporary demo posture. Do not add
  an auth step in front of any `/api/v1/*` **read** route, and never put
  a login or paywall in front of anything a client -- `apps/cli` or an
  agent calling `apps/api` directly -- uses. The one exception is the
  operator-only `/api/v1/admin/*` surface (§10.5a), secret-gated and
  never reachable from any user-facing surface -- it triggers pipeline
  runs, not data access, and does not change this rule for every other
  route.
- Parameterize every SQL query.
- Validate all external payloads.
- Escape/sanitize untrusted job descriptions. Do not render source HTML with `dangerouslySetInnerHTML`.
- Limit outbound URL fetching to adapter-defined, allow-listed hosts to prevent SSRF.
- Set CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and appropriate `Permissions-Policy` headers.
- Redact authorization headers, cookies, and source payload bodies from logs.
- Use dependency scanning and lockfiles; patch critical vulnerabilities promptly.

### 11.2 Privacy posture

The product processes organization/job-post data, not candidate data. Do not collect names, email addresses, candidate profiles, or other personal information from sources. If an upstream payload unexpectedly includes personal data, exclude it from normalized records and raw archive retention wherever feasible.

Provide an operator-accessible source removal workflow. If a company requests removal from a privately operated instance, disable its source and remove retained raw payloads according to policy after legal review.

### 11.3 Legal and product copy

Include a footer/link in the application:

> “Signals are derived from publicly accessible job listings and may be incomplete or outdated. Verify current information at the linked source before contacting an organization.”

Do not label companies as “actively buying,” “in market,” or “budget approved.” Use phrasing such as “public hiring signal,” “matching role observed,” and “recent posting activity.”

---

## 12. Performance and reliability targets

| Metric                                                      |                                                                                                                                                                                                           Target |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| Main signal API, cached facet response                      |                                                                                                                                                                                  $p95 < 250$ ms in target region |
| Main signal API, uncached query                             |                                                                                                                                                                                  $p95 < 800$ ms for $50$ results |
| Default `signals list` page size                            |                                                                                                                                                                                            $\leq 50$ signal rows |
| **Detection latency** (posting live → queryable via the CLI) | $p50 \leq$ effective per-source `pollIntervalMinutes` (§5.2); this is the primary metric for this product's stated optimization goal and should be tracked explicitly, not inferred from ingestion success alone |
| **Free-tier budget headroom**                               |                                                                                              Queues ops and D1 writes stay $\leq 85\%$ of daily allowance at all times; cadence auto-widens before breach (§5.2) |
| Source ingestion success rate                               |                                                                                                                                                             $\geq 98\%$ excluding intentionally disabled sources |
| Duplicate job rate                                          |                                                                                                                                                                                $< 1\%$ of normalized active jobs |
| Source staleness alert                                      |                                                                                                                                                                 trigger after $24$ hours beyond expected cadence |
| Error budget                                                |                                                                                                                                              define after baseline; alert on $> 2\%$ API $5xx$ over $15$ minutes |

Implementation tactics:

- Select only list columns in feed queries; fetch detailed evidence on demand.
- Index filters used together.
- Cache facets for $5$ minutes and invalidate after successful ingestion batches.
- Use cursor pagination.
- Ensure CSV exports run asynchronously if results exceed a safe size threshold.
- Avoid N+1 queries; fetch evidence counts in aggregate queries.

---

## 13. Observability and operations

### 13.1 Structured events

Emit structured logs/events with:

- `request_id`
- `source_id`
- `provider`
- `run_id`
- `adapter_version`
- `http_status`
- `duration_ms`
- `jobs_received`
- `jobs_normalized`
- `signals_created`
- `error_code`

Never include access tokens, cookies, full raw payloads, or browser PII in logs.

### 13.2 Ops health script output

Not an in-app page — this is the output of the local ops script (§10.5)
run against D1 when an operator wants a status check. Show a compact
operational table:

| Source | Company | Provider | Last success | Next poll | Jobs | Failures | Status |
| ------ | ------- | -------- | ------------ | --------- | ---: | -------: | ------ |

Status definitions:

- **Healthy:** last successful run within expected cadence plus grace.
- **Delayed:** behind cadence but under $24$ hours.
- **Degraded:** repeated failures or schema validation issue.
- **Disabled:** intentionally not fetched.

### 13.3 Alerts

Alert administrators when:

- A provider-wide failure rate exceeds $20\%$ over $1$ hour.
- A source misses $24$ hours beyond its expected cadence.
- Schema mismatch is detected.
- Queue retries exhaust.
- API $5xx$ exceeds threshold.
- D1 query duration/regression crosses a set threshold.

---

## 14. Testing strategy

### 14.1 Unit tests

- Adapter raw payload parsing with stored, sanitized fixtures.
- Normalization for titles, locations, dates, and URLs.
- Role classification positive and negative examples.
- Signal scoring with exact expected component scores.
- Duplicate and job lifecycle transitions.
- Filter query parsing and SQL parameter construction.

### 14.2 Integration tests

- Worker routes against a local/test D1 database.
- Queue consumer idempotency: send identical message twice and assert one logical result.
- Ingestion source failure does not close active jobs.
- Role/company filter combinations return expected rows.
- Access-control checks for every admin route.

### 14.3 End-to-end tests

Use Playwright or equivalent:

1. Open `/signals`.
2. Select a role category.
3. Search/select a company.
4. Confirm URL state is shareable and reload-safe.
5. Open a signal and verify evidence/source link.
6. Tab through filters and CTA controls.
7. Test mobile viewport and $200\%$ zoom.
8. Confirm CSV export respects the currently applied filters.

### 14.4 Quality gates

Before merge:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Require code review for source adapters, migrations, security headers, and score formula changes.

---

## 15. CI/CD and deployment

### 15.1 Environments

| Environment | Purpose                        | Data                                               |
| ----------- | ------------------------------ | -------------------------------------------------- |
| Local       | Developer iteration            | Fixtures or isolated development D1                |
| Preview     | Pull-request API validation    | Synthetic or scrubbed sample data                  |
| Staging     | Integration and manual QA      | Separate source registry, limited approved sources |
| Production  | User-facing system             | Production D1/KV/Queue and secrets                 |

Never point preview deployments at production secrets or production write bindings.

### 15.2 Deployment sequence

1. Run migration validation against a disposable/test D1 database.
2. Deploy Worker API and Worker migrations to staging.
3. Run smoke tests against staging API.
4. Build the CLI and run it against the staging API origin (integration smoke test, not a deploy step — the CLI itself has no server-side deployment target).
5. Run E2E tests against the staging origin.
6. Promote Worker deployment to production.
7. Enable or update cron schedule only after source registry health is confirmed.

### 15.3 Rollback

- Keep versioned Worker deployments and retain the prior stable version.
- Use backward-compatible database migrations: expand, deploy, migrate data, contract later.
- Disable faulty adapters through source configuration without requiring a CLI release.
- Feature-flag new scoring formulas and compare output before making them default.

---

## 16. Acceptance criteria

### 16.1 Functional

- [ ] An administrator can add a Greenhouse, Lever, or Ashby source to a known company.
- [ ] Scheduled ingestion fetches enabled sources without exposing credentials to the browser.
- [ ] A job is not marked closed because a source fetch failed.
- [ ] New matching jobs generate attributable signals with canonical public job links.
- [ ] `GET /api/v1/signals` returns results ordered by score by default.
- [ ] The CLI/API accepts filtering by one or more roles and one company.
- [ ] A caller can request a single signal and receive the score explanation and evidence.
- [ ] CSV export includes only the currently filtered result set.
- [ ] The ops health script (§10.5) identifies stale, degraded, and disabled sources.

### 16.2 CLI output and scriptability

- [ ] Default output is valid JSON on stdout; a `--format table` flag is available for interactive human use.
- [ ] Exit codes are meaningful: `0` success, non-zero on error, distinct codes for auth/network/validation failures.
- [ ] Errors are written to stderr, never mixed into stdout JSON.
- [ ] No ANSI color codes or progress spinners are emitted when stdout is not a TTY (i.e., when piped).
- [ ] Long-running commands (e.g. `--watch`, if added) do not block a caller that only wants a single poll.

### 16.3 Security / operations

- [ ] No secret appears in client bundles, repository files, logs, or browser responses.
- [ ] All external source hosts are allow-listed in code/configuration.
- [ ] All API input is schema-validated and SQL is parameterized.
- [ ] Source fetch retries respect rate limits and do not create duplicate signals.
- [ ] Raw source payload retention expires automatically.
- [ ] Monitoring exposes ingestion success, source health, and API error rates.

---

## 17. Build order for an AI implementation agent

### Phase 0 — Foundation

1. Create the `pnpm` monorepo.
2. Scaffold the Worker application (`apps/api`).
3. Configure TypeScript strict mode, ESLint, formatting, environment validation, and test runners.
4. Create D1 migrations and local dev bindings.
5. Seed $20$ companies and realistic sanitized job fixtures.

### Phase 1 — Data core

1. Implement schema, repository functions, and source registry.
2. Implement Greenhouse adapter with fixture tests.
3. Implement job normalization, classification rules, observations, and lifecycle logic.
4. Implement queue-driven ingestion and cron scheduler.
5. Implement `new_job` signal generation and evidence persistence.

### Phase 2 — CLI

1. Scaffold `apps/cli` as a thin Node client over `apps/api`'s HTTP surface.
2. Implement `signals list` with role/company filtering, backed by seeded API data.
3. Implement `signals show <id>` (score breakdown, evidence).
4. Implement CSV export of the currently filtered result set.
5. Add structured JSON error handling and the exit-code conventions from §16.2.

### Phase 3 — Production hardening

1. Add remaining P0 adapters (SmartRecruiters, Workable, Recruitee, Personio) using the same contract.
2. Add company-level acceleration/burst signals (secondary context) and formula versioning.
3. Build out the source-management/health ops script (§10.5) as source count grows.
4. Add structured logging, alerting _to the operator_ (not user-facing push — see delivery model in the header), and retention cleanup.
5. Add CI preview, integration tests, and production deployment runbook.
6. Wire the detection-latency metric (§12) into the ops health script: track time between a job's `first_seen_at` and the source run that produced it, so cadence-tuning decisions are based on measured latency, not assumption.

### Phase 4 — Verification

1. Test against a small approved source cohort before expanding coverage.
2. Measure duplicate rate, source staleness, classifier precision, `GET /api/v1/signals` query latency, and **detection latency against the computed cadence target (§5.2)**.
3. Manually inspect a sample of newly surfaced role-level signals weekly for genuineness (real, open, correctly matched).
4. Tune score weights and cadence only through versioned configuration and documented review.

---

## 18. Implementation guardrails for the coding agent

- Treat all source content as untrusted input.
- Never invent API endpoints, source fields, dates, company data, or job statuses. Verify source contracts first.
- If a provider endpoint stops being public/stable, disable that adapter and show source status; do not add evasive scraping.
- Never put `API_KEY`, database credentials, tokens, or any secret in a CLI-side environment variable that could end up in shell history or a committed `.env`; secrets live server-side in the Worker only.
- Never fetch ATS sources directly from the CLI; the CLI only calls `apps/api`'s HTTP surface.
- Never render raw job HTML without sanitization; plain-text extraction is preferred for v1.
- Do not use a generic “AI classifier” where deterministic rules are enough. Make any model-assisted classification opt-in, server-side, auditable, and non-blocking.
- Preserve evidence and timestamps necessary to explain a signal.
- Prefer explicit, typed, small modules over a large abstraction layer.
- Keep CLI output honest and unadorned: no decorative spinners or color in piped output, clear error messages, and machine-parseable structure are mandatory (see §16.2).

---

## 19. Open decisions to resolve before production

Settled, no longer open: access model and tenancy. The product has no
login, is public/free for anyone to use, and is single-tenant only (no
`workspace_id`, no per-customer data boundary) — see §3, §10.5, §11.1.

1. **Source coverage:** which additional official ATS APIs beyond the §4.1 P0 list are worth building next, and in what order — driven by observed gaps in detected postings, not by legal gatekeeping (the trade-off in §1.3/§2.1 already accepts reduced legal-review overhead in exchange for coverage speed).
2. **Company/source registry supply:** who supplies and validates ATS board tokens at launch, and how does the registry grow over time without becoming a bottleneck on detection speed?
3. **Regional/role scope:** which countries/markets and which IT role categories are the actual target, so saved filters and source prioritization can focus effort where it matters most to the job seeker?
4. **Export policy:** what fields may be exported via CSV, and how long are exported files retained?
5. **Paid-tier threshold:** at what point (source count, or a detection-latency target the free tier can't hit) does moving to Workers Paid ($5/month) become worth it, given it removes the daily request cap and raises Queues/D1 allowances substantially (§5.2)?
6. **Cadence/coverage trade-off:** if source count grows to the point where the computed safe interval (§5.2) exceeds what feels acceptable, is the answer to prune less-valuable sources, tighten the role/location scope, or move to the paid tier?

---

## 20. Definition of done

The application is complete for MVP when an agent, invoking the CLI (`apps/cli`) on a person's behalf, can list genuine, matching, still-open job postings filtered by role and location, inspect transparent evidence pointing to the public job post, and export a current filtered queue as CSV. Company-level hiring trends remain available as secondary context. A separate, secure Cloudflare Worker (`apps/api`) reliably polls a wide set of official public ATS APIs on a cadence computed from the Cloudflare free-tier budget (§5.2), persists audited observations, computes explainable role-level and company-level signals, exposes no secrets to the CLI or any other caller, requires no push/alerting infrastructure, and reports its own operational health and detection latency so cadence and coverage decisions are made from measured data rather than assumption.
