# Hiring Signals Intelligence

Build spec: `hiring-signals-spec.md` at repo root. Read that first — this
README only tracks scaffolding status.

## Layout

```
apps/web/        Next.js 16 UI -> Cloudflare Pages
apps/api/        Cloudflare Worker API + scheduled ingestion (Hono)
packages/domain/ Zod schemas, shared types, role/provider taxonomies
packages/adapters/ AtsAdapter interface (spec 5.3); per-provider impls land in Phase 1
packages/db/     D1 repository functions (empty until Phase 1 migrations exist)
packages/ui/     Optional shared UI primitives (not scaffolded; see its README)
infrastructure/  D1 migrations + deploy scripts (empty until Phase 1)
```

## Status: Phase 0 (foundation) in progress

Done:
- pnpm workspace, strict TypeScript base config, Prettier, shared ESLint base
- `apps/web`: Next.js 16 + Tailwind + TS scaffold, `lib/api-client.ts` wired
  to call the Worker API only (never ATS providers directly, spec 12.1)
- `apps/api`: Hono Worker with request-id/security-headers/error-handler
  middleware chain, route stubs for signals/companies/facets/admin, a cron
  scheduler stub and queue-consumer stub, `wrangler.toml` with D1/KV/R2/
  Queues bindings and the 15-minute scheduler cron (spec 13.1)
- `packages/domain`: role taxonomy, ATS provider enum, NormalizedJob/Signal/
  IngestMessage Zod schemas, API envelope helpers

Not yet done (tracked against spec section 20):
- D1 migrations (spec 8.2) and seed fixtures (Phase 0 item 5) -- deferred
  deliberately per project decision
- Per-provider adapter implementations (Phase 1/3, spec 5.3, 20)
- Any actual D1-backed queries in routes (currently stubs returning `[]`)
- Auth (Cloudflare Access, spec 14.1) -- admin routes only soft-gate on
  `ENVIRONMENT !== "production"` right now; **do not deploy to production
  as-is**
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
