# lib/

Standalone, project-agnostic utilities extracted from this codebase.
Nothing in here imports from `@hiring-signals/*` or references
signals/jobs/companies/ATS providers by name. Each file lists its own
dependencies (if any) in its header comment and is meant to be copied
wholesale into another project — there's no package boundary to respect,
just files.

This repo's own `apps/` and `packages/` code imports from here too (see
each module's "Used by" note below), so `lib/` isn't a fork — it's the
canonical implementation, kept generic on purpose.

## Modules

| File | What it is | Depends on |
|---|---|---|
| `d1/client.ts` | Thin, parameterized D1 query wrapper (`first`/`all`/`run`/`batch`), every call routed through `http/circuit-breaker.ts` on the `"db"` resource | Cloudflare Workers types, `http/circuit-breaker.ts` |
| `d1/like-pattern.ts` | Escapes `%`/`_` in user input before building a `LIKE` pattern | none |
| `d1/unique-constraint.ts` | Detects UNIQUE-constraint violations in D1 error results (cross-driver: matches `wrangler d1 execute --json`'s `error_code` strings and the in-Worker `D1Error.code` surface) | none |
| `kv/ttl-store.ts` | Generic TTL-keyed KV blob store (prefix + retention window) | `@cloudflare/workers-types` |
| `text/base64url.ts` | UTF-8-safe, URL-safe base64 encode/decode (+ JSON helpers) | none |
| `text/csv.ts` | RFC-4180 compliant CSV row serializer with proper quoting/escaping, used by `GET /export/signals.csv` | none |
| `text/rss.ts` | Dependency-free RSS 2.0 feed serializer (XML-escaped content, RFC 822 dates, `<link>` omitted when null), used by `GET /feed.rss` | none |
| `pagination/cursor.ts` | Opaque keyset-pagination cursor codec, mode-tagged so a sort change between pages is rejected instead of silently corrupting results | `text/base64url.ts` |
| `http/security-headers.ts` | Hono middleware: baseline security headers + explicit-allowlist CORS | `hono` (type-only) |
| `http/rate-limit.ts` | KV sliding-window per-IP rate limiter, free/protected tier presets. `safeRateLimitIdentifier()` SHA-256 base64url hashes before key construction to scrub plaintext IP PII and prevent IPv6 colon separator injection. | `@cloudflare/workers-types` |
| `http/circuit-breaker.ts` | Circuit breaker + per-resource bulkhead (concurrency limit) for external deps; used by `d1/client.ts` on the `"db"` resource | none |
| `observability/audit-abuse.ts` | Fire-and-forget abuse-event logging to a KV namespace | `@cloudflare/workers-types` |
| `text/location-mode.ts` | Infers remote/hybrid/onsite/unknown from a free-text location string | none |
| `text/content-hash.ts` | Deterministic SHA-256 content hash (Web Crypto) over a stable-key-order field object, used to detect record edits between observations | none |

## Using this in a new project

Copy the file(s) you need plus anything listed in its "Depends on"
column. Each file works on its own — there's no shared internal state or
required init step across modules.

## Keeping this in sync

If you fix a bug or improve one of these in `packages/*` or `apps/*`,
port the fix back here too (or better: change `lib/` first and have the
project code import from it, so there's only one copy to fix). Don't let
this drift into a snapshot that quietly diverges from what the app
actually runs.
