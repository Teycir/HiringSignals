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
| `d1/client.ts` | Thin, parameterized D1 query wrapper (`first`/`all`/`run`/`batch`) | Cloudflare Workers types only |
| `d1/like-pattern.ts` | Escapes `%`/`_` in user input before building a `LIKE` pattern | none |
| `kv/ttl-store.ts` | Generic TTL-keyed KV blob store (prefix + retention window) | `@cloudflare/workers-types` |
| `text/base64url.ts` | UTF-8-safe, URL-safe base64 encode/decode (+ JSON helpers) | none |
| `pagination/cursor.ts` | Opaque keyset-pagination cursor codec, mode-tagged so a sort change between pages is rejected instead of silently corrupting results | `text/base64url.ts` |
| `http/security-headers.ts` | Hono middleware: baseline security headers + explicit-allowlist CORS | `hono` (type-only) |
| `text/location-mode.ts` | Infers remote/hybrid/onsite/unknown from a free-text location string | none |

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
