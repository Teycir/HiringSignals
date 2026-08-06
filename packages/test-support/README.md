# `@hiring-signals/test-support`

Live Cloudflare transport bindings for `@hiring-signals` integration tests —
real `D1Client`/`D1Database`/`Ai`/`VectorizeIndex`/`KVNamespace`
implementations, backed by real network calls against this repo's real,
shared `hiring-signals` Cloudflare account. Nothing in this package is an
in-memory stand-in.

## Why real clients, not mocks

Per `AGENTS.md`'s "zero mocks, zero fakes" policy: `packages/db` and
`apps/api`'s test suites run the real, unmodified application code
(`createCompany`, `handleIngestMessage`, etc.) against real Cloudflare
resources, not a synthetic in-memory substitute for `D1Database`, `Ai`,
`VectorizeIndex`, or any KV namespace. There is no way to construct a
live Cloudflare binding outside a deployed Worker, so every module here
shells out to a real transport instead — `wrangler d1 execute --remote
--json` for D1, and direct Cloudflare REST calls (the same shape
`infrastructure/scripts/backfill-embeddings.mjs` already established)
for Workers AI, Vectorize, and KV. A test importing from this package is
exercising the real thing, end to end, not asserting against a fake's
own recorded call log.

`packages/domain` and `packages/adapters` don't use this package at all
— they're pure-logic suites against static fixtures and were already
policy-compliant before this package existed.

## Modules

### `d1-remote-transport.ts` — shared D1 transport

The actual `wrangler d1 execute --remote --json` process-spawning,
retry, and `?`-placeholder-inlining logic every D1-backed helper below
is built on. Not usually imported directly by test files — `live-d1-client.ts`
and `live-d1-database.ts` both wrap it, and that's the surface tests
should import from (see `index.ts`).

- **Target resource:** the live, remote `hiring-signals` D1 database
  (or `hiring-signals-ci` when `D1_DATABASE_NAME`/`D1_WRANGLER_ENV` are
  set — see below).
- **Auth:** `CLOUDFLARE_API_TOKEN` or `CF_TOKEN`, resolved via
  `requireCfToken()` (see "Environment variables" below). Throws
  immediately, before spawning any subprocess, if neither is set
  anywhere.
- **Retry:** up to 2 extra attempts (3 total, 500ms/1500ms backoff)
  *only* for a narrow, specifically-matched set of transient-auth
  failure signatures (Cloudflare error codes 7403/10000, wrangler's
  "Not logged in" message) — see `isTransientAuthFailure`'s own doc
  comment for the reproduced evidence this is based on. A real SQL
  error, a malformed `--json` response, or a genuine standing
  credential problem fails on the first attempt, not masked by a
  retry.
- **Failure mode:** rejects with the real wrangler stderr/stdout, plus
  a truncated (~500 char) preview of the SQL that failed. Values
  inlined into that SQL are always test-authored literals (UUIDs, enum
  strings, small integers) — never end-user input — so the truncation
  is a debugging-usability limit, not a redaction for sensitivity.

### `live-d1-client.ts` — `createLiveD1Client()`

A real `D1Client` (`lib/d1/client.ts`'s thin interface —
`first`/`all`/`run`/`batch`) for tests that call `packages/db` repo
functions (`createCompany`, `listSignals`, …) directly with an
explicit client argument.

- **Target resource / auth / failure mode:** same as
  `d1-remote-transport.ts` above (this file is a thin wrapper over it).

### `live-d1-database.ts` — `createLiveD1Database()`

A real `D1Database` (the raw Cloudflare Workers binding shape —
`prepare().bind().first/all/run()`, plus `batch()`) for tests of
`apps/api/src/jobs/*.ts` handlers (`handleIngestMessage`,
`handleScheduled`, `handleReconciliation`), which take `Bindings["DB"]`
via `env.DB` and construct their own `D1Client` internally via
`createD1Client(env.DB)`. Pass this as `env.DB` to run that
construction, and every query it makes, completely unmodified against
real Cloudflare.

- **Target resource / auth / failure mode:** same as
  `d1-remote-transport.ts` (built on the same transport).
- Implements `prepare`/`batch`/`exec`(throws)/`withSession`(throws)/
  `dump`(throws) — `exec`/`withSession`/`dump` have no real caller
  anywhere `createD1Client` reaches, so they throw a clear "not
  implemented" error rather than silently returning a wrong shape.
  `D1PreparedStatement.raw()` is similarly unimplemented for the same
  reason.

### `live-cf-bindings.ts` — `createLiveAiBinding()`, `createLiveVectorizeIndex()`, `createLiveKvNamespace()`

Real `Ai`, `VectorizeIndex`, and `KVNamespace` implementations.

- **Target resources:** Workers AI (model `@cf/baai/bge-base-en-v1.5`,
  via direct `POST .../ai/run/<model>` REST), the `hiring-signals-jobs`
  Vectorize index (v2 REST — `query`, `upsert`, `deleteByIds`), and any
  of the three KV namespaces declared in `apps/api`'s `wrangler.toml`
  (`CACHE`, `RAW_PAYLOADS`, `ABUSE_LOGS` — `createLiveKvNamespace()`
  defaults to `CACHE`, pass a `LiveKvBinding` name for the other two).
- **Auth:** AI/Vectorize authenticate via `Authorization: Bearer
  <token>` REST headers; KV goes through `wrangler kv key
  put/get/delete --remote`, authenticated the same way as the D1
  transport (`CLOUDFLARE_API_TOKEN` env var passed to the spawned
  process). All three resolve their token via the same
  `requireCfToken()` that `d1-remote-transport.ts` exports — one
  implementation, not a second copy.
- **Failure mode:** AI/Vectorize reject with the HTTP status and a
  truncated response body on a non-2xx or a Cloudflare-envelope
  `success: false`. KV rejects with wrangler's real stderr/stdout,
  except `get()` on a missing key (returns `null`, matching
  `KVNamespace.get`'s own documented behavior) and `delete()` on an
  already-absent key (no-op, KV delete is idempotent by design).
- Only implements the methods this repo's app code and test files
  actually call (`Ai.run`; `VectorizeIndex.query`/`upsert`/
  `deleteByIds`; `KVNamespace.get`/`put`/`delete`) — not the full type
  surface.

## Environment variables

| Variable | Required by | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` or `CF_TOKEN` | every module above | Resolved via `requireCfToken()` (`d1-remote-transport.ts`), checked in that order, then as a `CF_TOKEN=`/`CLOUDFLARE_API_TOKEN=` line in `.env.local` at the repo root. Must be scoped to D1: Edit, Workers AI: Edit, Vectorize: Edit, and KV: Edit — see `.env.local`'s own header comment for the full scope rationale. |
| `D1_DATABASE_NAME` | `d1-remote-transport.ts` | Defaults to `hiring-signals` (production). Set to `hiring-signals-ci` to target the isolated CI database instead. |
| `D1_WRANGLER_ENV` | `d1-remote-transport.ts` | Defaults to none (top-level `wrangler.toml` binding). Set to `ci` alongside `D1_DATABASE_NAME=hiring-signals-ci` to target `wrangler.toml`'s `[env.ci]` block. |

**A missing token fails loudly and immediately** — `requireCfToken()`
throws before any subprocess is spawned or any HTTP request is made,
with a message naming exactly which env vars or `.env.local` line would
satisfy it. There is no silent no-op / empty-result fallback anywhere
in this package for a missing credential.

## What every caller should know before importing this package

- **Shared, not isolated, by default.** Unless `D1_DATABASE_NAME`/
  `D1_WRANGLER_ENV` point at the CI database, every call here reads and
  writes the same live `hiring-signals` D1 database, Vectorize index,
  and KV namespaces the deployed app and ops scripts use. See
  `AGENTS.md`'s "zero mocks, zero fakes" section for the full accepted
  trade-offs (shared-instance risk, no scoped-down credential,
  concurrency not mitigated) — this package is the transport layer for
  that decision, not a place to quietly reintroduce isolation.
- **Slow, on purpose.** Every call is a real network round trip (a
  spawned `wrangler` CLI process for D1/KV, a direct HTTPS request for
  AI/Vectorize) — expect single-digit seconds per D1 call and real
  Workers AI/Vectorize latency per embed/query/upsert, not
  millisecond in-memory-fake speed. Test files built on this package
  size their own `testTimeout` accordingly (see
  `apps/api/test/jobs/ingest-consumer.test.ts`'s `vitest.config.ts`
  override and its own per-test timeout notes).
- **Cleanup is the caller's job.** Nothing in this package deletes what
  it writes — every test file importing it is responsible for its own
  teardown (see `ingest-consumer.test.ts`'s `cleanupCompany`/
  `cleanupVector` for the established pattern: FK-safe delete order, a
  `finally` per test, best-effort Vectorize cleanup).
