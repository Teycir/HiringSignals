# Hiring Signals Intelligence

Build spec: `hiring-signals-spec.md` at repo root. Read that first — this
README only tracks scaffolding status.

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

## Status: Phase 0 complete, Phase 1 (D1 + read paths) in progress

Done:
- pnpm workspace, strict TypeScript base config, Prettier, shared ESLint base
- `apps/web`: Next.js 16 + Tailwind + TS scaffold, `lib/api-client.ts` wired
  to call the Worker API only (never ATS providers directly, spec 12.1)
- `apps/api`: Hono Worker with request-id/security-headers/error-handler
  middleware chain, a cron scheduler stub and queue-consumer stub,
  `wrangler.toml` with D1/KV/R2/Queues bindings and the 15-minute scheduler
  cron (spec 13.1)
- `packages/domain`: role taxonomy, ATS provider enum, NormalizedJob/Signal/
  IngestMessage Zod schemas, API envelope helpers
- `infrastructure/d1/migrations/0001_initial_schema.sql`: full schema from
  spec 8.2 (companies, sources, source_runs, jobs, job_observations, signals,
  signal_evidence + the three feed/lookup indexes)
- `packages/db`: parameterized D1 client wrapper (spec 14.1) plus
  `signals-repo`, `companies-repo`, `facets-repo` -- cursor-paginated signal
  feed (score_desc/newest/company_asc), signal detail with evidence,
  company autocomplete + detail + recent signals, and KV-cached facet counts
- `apps/api` routes `GET /api/v1/signals`, `/signals/:id`, `/companies`,
  `/companies/:slug`, `/facets` now query D1 for real (no longer stubs)

Not yet done (tracked against spec section 20):
- Running the migration against an actual D1 database (needs real
  `database_id` in `wrangler.toml`, currently `REPLACE_WITH_D1_DATABASE_ID`)
  and seed fixtures (Phase 0 item 5) -- deferred deliberately per project
  decision
- Per-provider adapter implementations (Phase 1/3, spec 5.3, 20), and the
  `sources`/`jobs` write-path repos the ingestion consumer needs
- Wiring the cron scheduler + queue consumer to real D1 queries (still stubs)
- Auth (Cloudflare Access, spec 14.1) -- admin routes only soft-gate on
  `ENVIRONMENT !== "production"` right now; **do not deploy to production
  as-is**
- `locationMode`/`country` filters on `GET /api/v1/signals` are accepted but
  not yet applied (need a join to jobs/signal_evidence to filter by location)
- Brutalist design tokens / dashboard UI (Phase 2)

## Local dev

```bash
pnpm install
pnpm --filter @hiring-signals/web dev     # Next.js dev server
pnpm --filter @hiring-signals/api dev     # wrangler dev (Worker API)
```

`apps/api` needs real D1/KV/R2/Queue resource IDs in `wrangler.toml` before
`wrangler dev`/`deploy` will work against real Cloudflare resources --
placeholders are marked `REPLACE_WITH_...`.
