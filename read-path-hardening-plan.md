# Read-Path Hardening: Closing the Remaining Bare D1 Reads

**Repo:** `Repos/HiringSignals`
**Status:** Planning -- not yet implemented. Written after triaging a
production report (evidence tab on the signal detail page, `/signals/{id}`,
intermittently showing "Something went wrong processing the request").
**Context:** Companion to `snapshot-persistence-plan.md` (root cause,
mechanism, and generic snapshot-store design for `signals`/`trends`) and
`prod-test-data-incident-2026-09-03.md` (the D1 free-tier quota incident
that first exposed this class of bug). This document extends that same
mechanism to every other route still missing it, instead of re-solving the
same problem ad hoc per route.

---

## 1. Triage: what's actually broken

The reported bug -- the evidence/detail page at `/signals/{signalId}`
flapping between working and "Something went wrong processing the
request" -- traces to `apps/api/src/routes/signals.ts`'s
`GET /:signalId` handler:

```ts
const detail = await getSignalDetail(client, signalId);
```

No `try/catch`, no fallback. Any D1 hiccup (most commonly the account-wide
free-tier daily row-read quota documented in
`prod-test-data-incident-2026-09-03.md`, since every D1 call shares one
circuit breaker -- `lib/d1/client.ts`) throws straight through to
`error-handler.ts`'s generic mapper, which is the literal source of the
"Something went wrong processing the request" string the user sees.

This was **not** covered by `snapshot-persistence-plan.md`: that plan's
scope was explicitly `GET /signals` (list) and `GET /trends/hiring`. The
signal detail route was never touched, so it never got the fallback the
list route did.

## 2. Full inventory -- every route still reading D1 with no fallback

Re-auditing every route file against the same standard
`snapshot-persistence-plan.md` already applied to `signals.ts`/`trends.ts`:

| Route | D1 call(s) | Current state | Shape |
|---|---|---|---|
| `signals.ts` `GET /:signalId` | `getSignalDetail` | **bare, no try/catch** | single entity by fixed key (signalId) |
| `companies.ts` `GET /:slug` | `getCompanyBySlug` + `getRecentSignalsForCompany` | **bare** | single entity by fixed key (slug) |
| `companies.ts` `GET /:slug/timeline` | `getCompanyBySlug` + `getCompanyHiringTimeline` | **bare** | parameterized (since/until/bucketDays/role) -- unbounded key space |
| `companies.ts` `GET /:slug/role-activity` | `getCompanyBySlug` + `getCompanyRoleActivity` | **bare** | parameterized (role) |
| `companies.ts` `GET /:slug/jobs` | `getCompanyBySlug` + `listJobsForCompany` | **bare** | cursor-paginated, filtered |
| `facets.ts` `GET /` | `getFacets` | KV cache wraps it, but the D1 call itself is unguarded (documented gap, `snapshot-persistence-plan.md` §9) | single fixed key |
| `sources.ts` `GET /` | `listSources` | **bare** | small table, filtered by companyId/limit |
| `export.ts` `GET /signals.csv` | `listSignalsForExport` | **bare** | on-demand bulk dump, unbounded filter surface |
| `feed.ts` `GET /feed.rss` | `listSignalsForFeed` | **bare** | on-demand bulk dump, unbounded filter surface |

`signals.ts` `GET /` and `trends.ts` `GET /hiring` are the only two routes
already hardened -- everything above is a gap.

## 3. Reusable mechanism -- nothing new to build

`lib/d1/snapshot-store.ts` and `lib/kv/snapshot-mirror.ts`
(`snapshot-persistence-plan.md` §4/§10) are already fully generic on
`(domain, entity_key)` -- `entity_key` is an arbitrary string, not
restricted to the 10 role categories `trends` happens to use. That means a
per-entity key (a signal's UUID, a company's slug) fits the existing
tables and existing read/write helper shape with zero migration and zero
new infrastructure. The fix here is applying the established mechanism
where it fits, and applying a lighter, well-precedented guard where it
doesn't.

Two different degrade shapes are already established elsewhere in this
codebase, and each route below gets whichever one actually matches its
own shape -- forcing every route into one mold is not the goal:

- **Snapshot fallback** (`signals.ts`/`trends.ts` today): for a read with a
  small, enumerable key space (a fixed feed, one row per role category).
  Extends cleanly to "one row per signal ID" / "one row per company slug"
  *only* for endpoints whose whole answer is capturable as one payload at
  a fixed key -- not for endpoints whose answer varies by caller-supplied
  filters (since/until windows, roles, cursors), where the key space is
  unbounded and a snapshot can't cover it (this is exactly the reasoning
  `signals.ts`'s own header comment already gives for why its list route
  is live-first with a *degraded* single-page snapshot fallback, not a
  full reimplementation).
- **Clean try/catch to a proper status code** (`InvalidCursorError` -> 400
  today): for a read where there's nothing sensible to fall back to (a
  bulk CSV/RSS export, a paginated/filtered sub-resource), but where a raw
  500 with an opaque message is still worse than a clear "the data
  service is temporarily unavailable, try again" the client can act on.
  This is a smaller, honest fix: it doesn't make the endpoint available
  during a full D1 outage, but it stops leaking an opaque `INTERNAL_ERROR`
  for a known, already-diagnosed failure mode, and gives the client (and
  a human looking at logs) an accurate signal instead of a generic one.

## 4. Per-route plan

### 4.1 `signals.ts` `GET /:signalId` -- snapshot fallback (primary fix)

- New snapshot domain `signal_detail`, `entity_key = signalId`.
- Payload: the full `SignalDetail` object (header + evidence + score
  components + lastSourceRunAt) -- exactly what `getSignalDetail` returns
  today, captured verbatim so the fallback is byte-for-byte what a healthy
  request would have returned as of last capture.
- **Write path**: reconciliation's `handleSnapshotCapture` cannot
  practically snapshot *every* signal ID up front (unbounded, grows
  forever, most are never viewed) the way it snapshots the bounded
  `default_feed`/`trends` sets. Instead, capture **lazily, on a
  successful live read**: every time `GET /:signalId` succeeds against
  live D1, write-through the result into the `signal_detail` snapshot for
  that ID (D1 + KV mirror, best-effort, never blocking or failing the
  response). This means: the first successful view of a signal seeds its
  own fallback; a signal that's never been viewed has no snapshot yet and
  genuinely has nothing to fall back to (equivalent to "reconciliation
  hasn't run yet" elsewhere in this codebase) -- rare in practice since a
  page can't flap between broken and working (the reported symptom)
  without having succeeded at least once already.
- **Read path**: try live `getSignalDetail` first (cheap, indexed
  single-row lookup + evidence join -- same cost profile as `listSignals`,
  not `getHiringTrends`'s unbounded scan, so live-first is the right
  default here for the same reasoning `signals.ts`'s header comment
  already gives). On failure: D1 snapshot -> KV mirror -> 404-shaped
  "not found" only differs from a real not-found by an added
  `degraded: true` in `meta` (mirrors `trends.ts`'s `degraded` field) so
  the client can distinguish "this signal doesn't exist" from "we
  couldn't confirm it exists right now."
- A snapshot's `expiresAt`/`status` fields are last-known-good, not live
  -- same acceptable staleness tradeoff the list/trends snapshots already
  make (no TTL, served indefinitely until the next successful capture).

### 4.2 `companies.ts` `GET /:slug` -- snapshot fallback

- New snapshot domain `company_detail`, `entity_key = slug`.
- Payload: `{ company: CompanySummary, recentSignals: CompanyRecentSignal[] }`
  -- the exact response shape this route returns today.
- Same lazy-capture-on-success write path and live-first read path as
  §4.1, same reasoning (bounded-cost live query, unbounded ID space makes
  eager capture impractical, first successful view seeds the fallback).

### 4.3 `companies.ts` `GET /:slug/timeline`, `GET /:slug/role-activity`, `GET /:slug/jobs` -- try/catch to 503, no snapshot

- These three are parameterized by caller-supplied filters
  (since/until/bucketDays/role for timeline, role for role-activity,
  roles/locationMode/status/cursor for jobs) -- an unbounded key space, the
  same reason `signals.ts`'s own list route doesn't attempt a full
  snapshot reimplementation of its live query, only a deliberately
  degraded single-page fallback for the *unfiltered* case. These three
  have no unfiltered/default case simple enough to snapshot the same way
  (a timeline snapshot would need one row per since/until/bucketDays
  combination a caller could ever send).
- Fix: wrap the D1 call(s) in try/catch, map any failure other than an
  already-handled domain error (`InvalidJobsCursorError`, the window
  validation in `resolveTimelineWindow`) to a `503 SERVICE_UNAVAILABLE`
  with a clear message, instead of falling through to `error-handler.ts`'s
  generic `500 INTERNAL_ERROR`. This is honest about the limitation (no
  data during a real D1 outage) rather than pretending a snapshot exists
  where one doesn't -- but it stops presenting a diagnosed, known failure
  mode as an opaque, unexplained crash.
- `getCompanyBySlug`'s own bare call at the top of all three handlers gets
  the same 503 treatment inline (not a separate snapshot, since these
  three routes already depend on parameterized reads that can't be
  snapshotted anyway -- no point solving the existence-check half of the
  problem and leaving the timeline/activity/jobs half bare).

### 4.4 `facets.ts` -- close the documented gap

- `snapshot-persistence-plan.md` §9 already flags this exact gap:
  "`facets.ts`'s equivalent gap... still open as a follow-up -- same fix
  shape as §10's KV mirror would apply here too... not yet built." This
  plan builds it.
- New snapshot domain `facets`, single fixed `entity_key = "current"`
  (mirrors `SIGNALS_DEFAULT_FEED_KEY`'s single-key pattern -- facets has
  no per-caller variation, it's one global aggregate).
- Write path: add a step to `handleSnapshotCapture` (alongside the
  existing trends/signals captures) that computes `getFacets` once a day
  and writes it to both the D1 snapshot and the KV mirror -- same
  "capture off request traffic, serve from snapshot indefinitely"
  discipline as the other two.
- Read path: keep the existing 60s short-TTL KV cache as the fast path
  (cheap, already working, no reason to remove), but change what happens
  on a cache miss: try live `getFacets` -> D1 `facets` snapshot -> KV
  mirror, in that order, instead of today's bare `getFacets(client)` call
  with nothing behind it.

### 4.5 `sources.ts` -- try/catch to 503, no snapshot (small, low-value target)

- `listSources` is a small, low-cardinality table (one row per configured
  ATS source, not per-signal/per-company) queried with a `companyId`
  filter and a `limit`. Low request volume in practice (used by
  signal-feed.tsx/masthead.tsx for staleness detection, not a
  user-facing page of its own) and a small enough table that a full
  snapshot mechanism is disproportionate.
- Fix: try/catch around `listSources`, map a D1 failure to `503` with a
  clear message, same reasoning as §4.3 -- honest about the limitation,
  no opaque 500.

### 4.6 `export.ts` / `feed.ts` -- try/catch to 503, no snapshot

- Both are on-demand bulk dumps (`EXPORT_ROW_CAP`/`FEED_ROW_CAP`) over an
  unbounded caller-supplied filter surface (roles/company/q/locationMode/
  country/source/signalType/minScore/observedSince) -- the exact "open,
  unbounded surface" `snapshot-persistence-plan.md` §1/§6 already rejected
  snapshotting for arbitrary filter combinations on the list route itself.
  A snapshot fallback here would face the identical combinatorial problem,
  for a lower-traffic, pull-on-demand endpoint (a human exporting a CSV or
  a feed reader polling) where "try again shortly" is a reasonable answer
  during a real D1 outage, unlike the primary feed/detail pages.
- Fix: same try/catch-to-503 treatment as §4.3/§4.5.

## 5. Consistent error shape for the try/catch-to-503 routes (§4.3/§4.5/§4.6)

All five non-snapshotted fixes (timeline, role-activity, jobs, sources,
export, feed -- six call sites, five route files) return the same shape on
a D1 failure, so a client can handle "D1 temporarily unavailable" once
generically rather than per-route:

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "This data is temporarily unavailable. Please try again shortly.",
    "requestId": "..."
  }
}
```

HTTP 503, not 500 -- signals "retry later," which is actually true here,
rather than `error-handler.ts`'s generic `INTERNAL_ERROR` framing, which
suggests a bug rather than a known, transient capacity condition.

## 6. What this does NOT do

- Does not add a new D1 migration -- `snapshots_current`/`snapshots_history`
  (migration 0011) already exist and are fully generic on
  `(domain, entity_key)`.
- Does not change `signals.ts` `GET /` or `trends.ts` `GET /hiring` --
  both already hardened, out of scope here.
- Does not attempt to snapshot every parameterized/filtered endpoint --
  §4.3/§4.5/§4.6 are a deliberate, precedented "fail clearly instead of
  falling back" choice, not an oversight, for the same reason
  `snapshot-persistence-plan.md` itself never attempted to snapshot
  `listSignalsForExport`'s full filter surface.
- Does not change the shared D1 circuit breaker (`lib/http/circuit-
  breaker.ts`) itself -- every fix here works within its existing
  behavior (a `CircuitBreakerError` is just one of the possible causes
  a route's try/catch now handles, not a special case).

## 7. Implementation order

1. `packages/db/src/snapshot-repo.ts` -- add `signal_detail`,
   `company_detail`, and `facets` domains/payload types + D1 and KV-mirror
   read/write helpers, following the exact existing pattern for
   `SNAPSHOT_DOMAIN_SIGNALS`/`SNAPSHOT_DOMAIN_TRENDS`.
2. `apps/api/src/routes/signals.ts` `GET /:signalId` -- live-first +
   lazy-capture-on-success + D1 snapshot -> KV mirror fallback (§4.1).
3. `apps/api/src/routes/companies.ts` `GET /:slug` -- same shape (§4.2).
4. `apps/api/src/jobs/reconciliation.ts` -- add the daily `facets`
   snapshot capture step (§4.4).
5. `apps/api/src/routes/facets.ts` -- wire the snapshot fallback behind
   the existing short-TTL cache (§4.4).
6. `apps/api/src/routes/companies.ts` `GET /:slug/timeline`,
   `GET /:slug/role-activity`, `GET /:slug/jobs` -- try/catch to 503
   (§4.3).
7. `apps/api/src/routes/sources.ts`, `export.ts`, `feed.ts` -- try/catch
   to 503 (§4.5/§4.6).
8. Typecheck all affected packages (`apps/api`, `packages/db`), smoke-test
   locally, commit, deploy.

## 8. Verification

- Signal detail page (`/signals/{id}` in `apps/web`): view a signal once
  live (seeds its snapshot), then simulate a D1 failure (or wait for a
  real quota exhaustion window) and confirm the page still renders from
  the snapshot instead of showing the error card from the reported bug.
- Company page (`/companies/{slug}`): same check.
- Facets-backed filter rail: confirm it still populates during a
  simulated D1 outage once the daily capture has run at least once.
- Timeline/role-activity/jobs/sources/export/feed: confirm a simulated D1
  failure now returns a clean `503 SERVICE_UNAVAILABLE` with the shape in
  §5, not a raw `500 INTERNAL_ERROR`.
