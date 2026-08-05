# `@hiring-signals/test-support`

Testing infrastructure and live Cloudflare transport bindings for `@hiring-signals` integration tests.

## Policy Alignment

Per `AGENTS.md` zero-mocks policy:
- Tests in `packages/db` and `apps/api` execute against **real, live Cloudflare resources** (`D1`, `KV`, `Workers AI`, `Vectorize`).
- Synthetic in-memory mocks, fakes, or stubbed bindings are retired.
- `packages/domain` and `packages/adapters` remain pure-logic suites with static fixtures.

## Modules & Resource Requirements

### 1. `live-d1-client.ts` (`execRemote`)
- **Target Resource**: Cloudflare D1 Database (`hiring-signals`).
- **Auth Requirement**: Ambient `wrangler` CLI authentication (`wrangler login` session or `CLOUDFLARE_API_TOKEN` environment variable).
- **Execution Mechanism**: Spawns `npx wrangler d1 execute --remote --json` subprocess calls against the live D1 database.
- **Failure Mode**: Throws clear error with command output if credentials or database bindings are missing/unauthorized.

### 2. `live-cf-bindings.ts` (`loadCfToken`, `createLiveKvBinding`, `createLiveAiBinding`, `createLiveVectorizeBinding`)
- **Target Resources**: Cloudflare KV Namespaces (`CACHE`, `RAW_PAYLOADS`, `ABUSE_LOGS`), Workers AI (`@cf/baai/bge-base-en-v1.5`), Vectorize Index (`hiring-signals-jobs`).
- **Auth Requirement**: `CF_TOKEN` defined in `.env.local` at repository root (parsed via `loadCfToken()` matching `CF_TOKEN=value` lines) or ambient environment.
- **Failure Mode**: Throws upfront `"Missing CF_TOKEN in .env.local or environment"` error before attempting API requests if token is absent.
