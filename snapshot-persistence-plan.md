# Generic Snapshot Persistence for `signals` and `trends`

**Repo:** `Repos/HiringSignals`
**Status:** Implemented for `signals`/`trends` (D1 snapshot + KV mirror, see
§10). `facets.ts` was NOT folded into this system -- still on the older
short-TTL KV cache this plan's §1 argued against; remains an open follow-up
(§9).
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

## 6. Read path (serve) -- as implemented

- **`trends.ts`** -- reads `snapshots_current` for `domain: "trends"` (one
  row per role category requested), aggregating/filtering/sorting those
  small precomputed rows in-process. Deliberately snapshot-FIRST, never
  live -- `getHiringTrends` (the live query this route used pre-rewrite)
  scans every `jobs` row for the requested roles before `limit` applies,
  the exact unbounded query that caused the original quota exhaustion, so
  it's kept off request traffic entirely and only runs once a day from the
  capture step (§5). On a D1 read failure, falls back to a KV mirror of
  the same snapshot (§10) rather than the live table.
- **`signals.ts`** -- unlike trends, tries the LIVE indexed query
  (`listSignals`) FIRST, not snapshot-first. This is a deliberate
  divergence from trends, not an inconsistency -- see signals.ts's own
  header comment for the full reasoning, summarized: `listSignals`'s live
  query is a bounded, indexed `WHERE ... LIMIT` read (cheap regardless of
  volume, unlike trends' unbounded scan), and only the live path supports
  this route's actual feature set (cursor pagination, full SQL `q` search,
  the semantic/Vectorize hybrid leg) -- the snapshot fallback is a
  deliberately degraded single-page/substring-search view, not a full
  reimplementation. On a live-query failure, falls back to the
  `domain: "signals"` / `entity_key: "default_feed"` snapshot with
  filters re-applied in-process (`filterSnapshotItems`), reporting
  `"degraded": true` when even that snapshot is unreachable and the KV
  mirror (§10) also comes up empty.
- **`facets.ts`** -- NOT migrated onto this system. Still uses the
  original short-TTL (60s) KV cache-with-fallback this plan's §1 argued
  against as the wrong tool going forward. Its underlying `getFacets`
  live D1 call remains unguarded by its own try/catch (only the KV
  read/write around it are guarded) -- same class of gap this plan
  originally set out to close, still open. See §9.

## 7. What this replaces

- Removed the old KV `trends:v1:*` / `trends:fallback:v1:*` cache/fallback
  logic (keyed per exact filter-parameter combination) from `trends.ts`,
  replacing it with the domain/entity_key-keyed snapshot system. A NEW,
  different KV usage was added later as a same-day follow-up (§10) -- this
  is a D1-snapshot mirror, not a live-query cache, and does not
  reintroduce the per-filter-combination gap the old KV logic had.
- Removed the unprotected direct-D1 call as the sole path in `signals.ts`,
  replacing it with a try/catch and fallback chain (§6).
- Did NOT close `facets.ts`'s equivalent gap -- deferred, see §6/§9.

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
   delete the OLD per-filter-combination KV cache logic. (A different,
   new KV usage -- the §10 mirror -- was added back the same day as a
   fallback rung; not a reversal of this step, see §7.)
7. `apps/api/src/routes/signals.ts` -- add snapshot fallback for the
   default feed path.
8. `apps/api/src/routes/facets.ts` -- same fallback treatment. **NOT
   done** -- see §6/§9, still open.

## 9. Open questions -- resolved / still open

- ~~Confirm the `entity_key` grain for `signals`...~~ RESOLVED: a single
  fixed key, `"default_feed"`, per §3/§6 as implemented.
- ~~Confirm folding `facets.ts` into the same change is in scope...~~
  RESOLVED: out of scope. `facets.ts` still runs its original short-TTL KV
  cache (§6), with its live `getFacets` D1 call unguarded by its own
  try/catch. Still open as a follow-up -- same fix shape as §10's KV
  mirror would apply here too (mirror the 60s-cached payload into a
  no-TTL KV key written by the daily cron, read as a fallback when both
  the live call and the short-TTL cache miss), not yet built.
- ~~Confirm migration numbering (`0011`)...~~ RESOLVED at implementation
  time; see the actual migration file in
  `infrastructure/d1/migrations/` for the number that landed.

## 10. KV mirror follow-up (2026-09-03 prod incident)

Added the same day as initial implementation, after a production incident
where D1's account-wide daily row-read quota was exhausted:
`snapshots_current` is still a D1 row, so an account-wide quota exhaustion
(not just a live-table-sized query) could still make the snapshot READ
itself throw -- §2's "read traffic can never hit the same D1 read-quota
wall" promise didn't fully hold in that specific failure mode, since the
snapshot read is itself a D1 call.

**Fix:** mirror every snapshot write into KV alongside its D1 write, no
TTL/expiry (same "served indefinitely until the next successful capture
overwrites it" philosophy as `snapshots_current` itself, per §2). KV has
its own quota, entirely separate from D1's, so a snapshot stays servable
from the last known-good capture even during a full D1 outage.

| File | Role |
|---|---|
| `lib/kv/snapshot-mirror.ts` (new) | Domain-agnostic `writeSnapshotMirror()` / `readSnapshotMirror()` / `readSnapshotMirrorsForDomain()` over KV, same `(domain, entity_key)` key shape as `lib/d1/snapshot-store.ts` -- the KV counterpart to that module, same `lib/` convention. |
| `packages/db/src/snapshot-repo.ts` | Extended (not a new file) with KV-mirror counterparts of the existing four D1 functions: `writeSignalsFeedSnapshotMirror`, `readSignalsFeedSnapshotMirror`, `writeTrendsSnapshotMirror`, `readTrendsSnapshotsMirror`. |
| `apps/api/src/jobs/reconciliation.ts` | `handleSnapshotCapture` calls the mirror write immediately after each D1 snapshot write (trends per-role-category, and signals default-feed), always best-effort -- a mirror-write failure never fails the capture pass or skips the D1 write it accompanies. |
| `apps/api/src/routes/trends.ts` | On a D1 snapshot-read failure, falls back to `readTrendsSnapshotsMirror` before reporting `degraded: true`. |
| `apps/api/src/routes/signals.ts` | Fallback chain extended to three rungs: live query -> D1 snapshot (`readSignalsFeedSnapshot`) -> KV mirror (`readSignalsFeedSnapshotMirror`). Only genuinely empty when all three fail. |

This is a **mirror of the daily-captured snapshot**, not a live-query
cache -- it inherits the snapshot's own `(domain, entity_key)` keying, so
it does not reintroduce the old per-filter-combination cache-key
explosion §1/§7 rejected. `lib/kv/snapshot-mirror.ts` never throws
internally (best-effort read/write) so callers can treat a failed mirror
lookup the same as "not found" rather than a new exception type to
handle.
