# Generic Snapshot Persistence for `signals` and `trends`

**Repo:** `Repos/HiringSignals`
**Status:** Proposed, not yet implemented
**Context:** Investigated live against the current codebase (D1/KV/route code
read directly) before writing this plan. Companion to `hiring-signals-spec.md`
and `ROADMAP.md` -- this document is the design for one specific fix, not a
replacement for either.

---

## 1. Problem

`apps/web` and `apps/cli` read `/api/v1/signals` and `/api/v1/trends/hiring`
from `apps/api`, which queries Cloudflare D1 live, on every request.

- Cloudflare's free-tier D1 has a daily row-read quota. When it's exhausted
  (or D1 hiccups transiently), the live query throws.
- `trends.ts` already has a KV-based "last known good" fallback (added
  2026-09-02, confirmed in code), but it's keyed per **exact filter-parameter
  combination**. Any new or uncommon filter combo has no fallback entry yet
  and still 500s. This is why trends is still visibly broken despite the
  earlier fix.
- `signals.ts` has **no fallback at all** -- confirmed by direct read of the
  route. `listSignals(client, ...)` is called with zero try/catch and zero
  caching. Any D1 failure 500s immediately, and the frontend shows nothing.
  This is almost certainly the primary cause of the "results appear, then
  disappear" symptom.
- `facets.ts` has the *KV read/write* wrapped in try/catch, but the
  underlying `getFacets(client)` D1 call itself is unguarded -- same class
  of bug, one route over.
- KV-as-cache is explicitly rejected as a fix going forward: it's the wrong
  tool here (separate quota from D1, subject to its own eviction, produces
  a combinatorial explosion of cache keys per filter combination, and
  fights the "keep serving last-known-data indefinitely" requirement
  because it's built around TTL expiry).

## 2. Target mechanism

Replace KV caching with **durable D1 snapshot storage**, decoupled entirely
from request traffic:

- **Capture** -- on each successful enrichment (the existing daily
  reconciliation cron), compute the domain's data and persist it.
- **Serve** -- every read request reads only the snapshot, never the raw
  live tables (`jobs` / `companies` / `signals` joins). Read traffic can
  therefore never hit the same D1 read-quota wall that ingestion/enrichment
  is subject to.
- **Wait for enrich** -- if the next cron run fails or doesn't happen, the
  snapshot is simply not touched. Readers keep getting the last successful
  result indefinitely. No TTL, no expiry, no "stale" flag needed --
  staleness isn't an error state here, it's the intended degrade path.
- **Next successful enrich** -- the current snapshot row is overwritten with
  new data. Before being overwritten, its prior contents are already
  durably preserved as an N-1 row in the history table (see write order in
  §4).
- **Historical table** -- append-only, one row per successful capture,
  never updated or deleted by application code. This is the audit/history
  trail.

## 3. Two generic tables, not per-domain schemas

`signals` and `trends` -- and any future consumer -- share the **same two
tables**, differentiated only by a `domain` column plus an arbitrary
`entity_key` string each caller defines:

- `trends` uses `entity_key = role_category` (10 fixed values,
  bounded/enumerable).
- `signals` uses a small fixed set of keys (e.g. `"default_feed"` for the
  unfiltered view).

| Table | Shape | Behavior |
|---|---|---|
| `snapshots_current` | one row per `(domain, entity_key)`, `UNIQUE(domain, entity_key)` | overwritten in place via `INSERT ... ON CONFLICT DO UPDATE`; holds `payload_json` + `captured_at` |
| `snapshots_history` | append-only, `(domain, entity_key, payload_json, captured_at, id)` | one row per successful write; never updated or deleted |

**Write order on each successful capture:**

1. Insert a new `snapshots_history` row with the freshly computed data.
2. Upsert `snapshots_current` with the same data.

"Keep N-1" falls out for free: N-1 is just the previous `snapshots_history`
row for that key, always queryable, never lost -- nothing needs to be
copied out of `snapshots_current` before overwriting it, because the row
that *was* current was already archived into history on its own prior
write.

## 4. Where the generic logic lives

| File | Role |
|---|---|
| `lib/d1/snapshot-store.ts` (new) | Domain-agnostic `writeSnapshot()` / `readSnapshot()` / `readSnapshotHistory()` over the two generic tables. Follows this repo's existing `lib/` convention (project-agnostic, copy-paste-able, zero project-specific imports) -- same tier as `lib/d1/client.ts` and `lib/kv/ttl-store.ts`. |
| `packages/db/src/snapshot-repo.ts` (new) | Thin, project-typed wrapper (`SignalsFeedSnapshot`, `TrendsSnapshot` payload types) that both signals- and trends-adjacent code call into. This is the one generic method both domains inherit from. |

## 5. Write path (capture)

Hooked into the existing daily cron, `handleReconciliation` (`0 6 * * *`),
which already runs once a day and touches every company/signal. Two new
steps added at the end of that run:

- Compute the full trends dataset per `role_category` (the bounded,
  enumerable grain -- 10 fixed values) and call
  `writeSnapshot(domain: "trends", entityKey: role_category, ...)` for each.
- Compute the default signals feed snapshot and call
  `writeSnapshot(domain: "signals", entityKey: "default_feed", ...)`.

This never runs on request traffic, so it can never itself be the cause of
read-path flakiness, and running once a day keeps it cheap against the D1
write-quota budget.

## 6. Read path (serve)

- **`trends.ts`** -- rewritten to read `snapshots_current` for
  `domain: "trends"` (one row per role category requested),
  aggregating/filtering/sorting those small precomputed rows in-process.
  No live `jobs`/`companies` JOIN on the read path. No KV.
- **`signals.ts`** -- the default/no-filter feed view reads from
  `snapshots_current` for `domain: "signals"`. Requests with real filters
  (`q`, `minScore`, `observedSince`, `cursor`, etc.) still need the live
  indexed query -- that filter surface is too open-ended to fully
  precompute -- but gain a try/catch so a live-query failure falls back to
  the snapshot's unfiltered data with an explicit `"degraded": true` marker
  in the response, instead of 500ing to an empty UI.
- **`facets.ts`** -- same fallback treatment folded in, since it's the same
  failure pattern as `signals.ts`, just smaller.

## 7. What this replaces

- Removes the KV `trends:v1:*` / `trends:fallback:v1:*` cache/fallback
  logic entirely from `trends.ts`.
- Removes the unprotected direct-D1 call as the sole path in `signals.ts`.
- Closes `facets.ts`'s equivalent gap (unprotected `getFacets` call once the
  60s KV cache expires).

## 8. Files to be touched

1. `infrastructure/d1/migrations/0011_snapshot_store.sql` -- new generic
   tables + indexes.
2. `lib/d1/snapshot-store.ts` -- new, generic read/write functions.
3. `lib/README.md` -- add the new module to the module table.
4. `packages/db/src/snapshot-repo.ts` -- new, typed wrapper; exported from
   `packages/db/src/index.ts`.
5. `apps/api/src/jobs/reconciliation.ts` -- add the two capture steps at
   the end of the daily run.
6. `apps/api/src/routes/trends.ts` -- rewrite to read-only-from-snapshot;
   delete KV logic.
7. `apps/api/src/routes/signals.ts` -- add snapshot fallback for the
   default feed path.
8. `apps/api/src/routes/facets.ts` -- same fallback treatment.

## 9. Open questions before implementation

- Confirm the `entity_key` grain for `signals` is acceptable as a small
  fixed set (e.g. `"default_feed"` only, or one key per role category
  mirroring trends) rather than per-arbitrary-filter-combination.
- Confirm folding `facets.ts` into the same change is in scope, or should
  be a separate follow-up.
- Confirm migration numbering (`0011`) is still free at implementation
  time (repo is active; another migration may land first).
