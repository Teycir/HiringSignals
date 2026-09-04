# Prod Test-Data Pollution Incident (2026-09-03 / 2026-09-04)

**Repo:** `Repos/HiringSignals`
**Status:** Root cause identified, scope fully counted (399 companies),
cleanup tool built and deployed, deletion blocked by D1 quota, **not yet
executed**. Pick up here next session.
**Context:** Follow-on to the same 2026-09-03 D1-quota incident documented
in `snapshot-persistence-plan.md` §10 (KV mirror fallback). That fix
addressed *reads* going degraded during D1 outages. This document covers a
second, distinct problem surfaced while verifying that fix: live-D1 test
runs interrupted during the same incident left test-fixture rows behind in
production D1, which the daily reconciliation cron will otherwise
re-capture into the KV mirror as if they were real data.

---

## 1. How this was found

While re-verifying the KV-mirror fallback from §10 was holding in
production, a direct call to `/api/v1/signals` returned rows with
`companySlug` values like `test-ser-order-5-1788476874478` and
`companyDisplayName` values like `"Order Export Co"`, `"Stats Filters Co"`,
`"Filters Export Co"` — timestamped the same day as the incident, not old
residue. Repeated calls showed the API flapping between:

- `servedFromSnapshot: true` — clean, served from the KV mirror seeded
  earlier that session (`snapshotCapturedAt: 2026-09-03T23:30:43.351Z`).
- `servedFromSnapshot: false` — live D1, which returns the pollution
  whenever D1 happens to answer directly instead of throwing.



## 2. Root cause

Live-D1 test files (`packages/db/test/*.ts`, `apps/api/test/jobs/*.ts`)
each seed rows under a `TEST_PREFIX`-namespaced slug (e.g. `test-ic-...`)
and clean them up in their own `finally`/`afterAll`, in FK-safe order:
`signal_evidence -> signals -> jobs -> source_runs -> sources ->
companies`. During the 2026-09-03 D1-quota incident (the same one
documented in `snapshot-persistence-plan.md` §10), several of these test
runs were interrupted mid-suite by the very D1 failures the incident was
about, before their teardown could fire. The seeded rows were left behind
in production D1 — not local/dev D1, because these test files run
against live D1 per the repo's "zero mocks, zero fakes" policy
(`AGENTS.md`). Each subsequent 06:00 UTC reconciliation cron then
captured whatever was in D1 at that moment into the KV snapshot mirror
(§10) with no filter distinguishing test fixtures from real data, so the
pollution was one cron tick away from becoming indistinguishable from
production data in the served snapshot.

## 3. Scope — confirmed via dry-run counts

`companies.slug` schema: `TEXT NOT NULL UNIQUE` (migration
`0001_initial_schema.sql`). Display name column is `display_name`, not
`company_display_name` — worth stating explicitly since this caused
friction while writing ad-hoc queries during triage.

399 polluted companies across 10 of 11 known test-prefix patterns
(`${prefix}-%` on `companies.slug`):

| Prefix | Companies |
|---|---:|
| `test-ic` | 117 |
| `test-jrp` | 62 |
| `test-swr` | 50 |
| `test-sr` | 40 |
| `test-sched` | 40 |
| `test-src` | 36 |
| `test-recon` | 22 |
| `test-trends` | 22 |
| `test-ser` | 10 |
| `test-crs` | 0 |
| `test-cr` | 0 |
| **Total** | **399** |

`test-cr` and `test-crs` were already clean at count time — most likely
because their owning test run completed normally and its own `afterAll`
swept them before the interruption hit other suites.


## 4. Cleanup route

`POST /api/v1/admin/test-data/cleanup` — `apps/api/src/routes/admin.ts`,
committed `da19adf`, deployed. Auth-gated via the existing `adminAuth()`
middleware (fail-closed secret check, `timingSafeEqual`, 3-strike/60s
lockout — same as the other admin routes).

Design choices, as reflected in the route's own code comments:

- **Fixed prefix allow-list**, not a caller-supplied LIKE pattern. The 11
  prefixes are hardcoded (`TEST_DATA_PREFIXES` in `admin.ts`), one per
  test file's own `TEST_PREFIX` constant. Accepting an arbitrary pattern
  in the request body would turn a cleanup tool into a mass-delete
  primitive; deliberately not done.
- **Dry-run by default.** Body is `{"confirm"?: boolean}` (Zod-validated,
  defaults to `false`). Without `confirm: true`, the route only counts
  matches per prefix and reports them — no deletes.
- **One `batch()` call per prefix**, not one batch for the whole
  operation. D1's `batch()` is the real transaction primitive here, so a
  mid-sequence failure on one prefix can't leave it half-deleted while
  still processing the other ten independently.
- **FK-safe delete order per prefix**, matching the test files' own
  teardown: `signal_evidence -> signals -> jobs -> source_runs ->
  sources -> companies`, all scoped by `company_id IN (SELECT id FROM
  companies WHERE slug LIKE ?)` (or the equivalent join for
  `signal_evidence`/`source_runs`).
- **Uses the Worker's own `env.DB` binding**, not the wrangler CLI's
  `d1 execute --remote` path. This was believed at design time to draw
  from a separate D1 quota than the CLI path (confirmed once, during the
  incident: the CLI path was exhausted while live Worker-bound queries
  still succeeded) — see §6 for why this turned out not to fully hold up
  on the next attempt.

Response shape: `{ data: { dryRun, totalMatchedCompanies, byPrefix: [{
prefix, companies, deleted }], note }, meta: { requestId } }`.

## 5. The `ADMIN_SECRET` saga

Setting the secret directly (`npx wrangler secret put ADMIN_SECRET`,
typed or pasted interactively) was unreliable during this session.
What worked cleanly:

```bash
cd /home/teycir/Repos/HiringSignals/apps/api
cat /tmp/admin_secret_new.txt | npx wrangler secret put ADMIN_SECRET
```

Piping the secret in from a file avoided whatever was going wrong with
interactive/pasted input. Output confirmed success:

```
🌀 Creating the secret for the Worker "hiring-signals-api"
✨ Success! Uploaded secret ADMIN_SECRET
```

One real warning surfaced in that output and is worth carrying forward:

```
▲ [WARNING] Multiple environments are defined in the Wrangler configuration
  file, but no target environment was specified for the secret put command.
```

This matches a deploy warning seen earlier the same day. It was not
chased down further this session (the secret upload was verified working
against the deployed `hiring-signals-api` Worker regardless), but the
safer form for next time is to pass the explicit flag:

```bash
cat /tmp/admin_secret_new.txt | npx wrangler secret put ADMIN_SECRET --env=""
```

The working secret value is left at `/tmp/admin_secret_new.txt` on the
dev machine on purpose — `/tmp` survives until reboot, and regenerating
it means another `secret put` round-trip.


## 6. Delete attempt — blocked by D1 quota, not a bug

With `ADMIN_SECRET` confirmed working, a real (non-dry-run) call was
made:

```bash
curl -X POST "https://hiring-signals-api.teycircoder14.workers.dev/api/v1/admin/test-data/cleanup" \
  -H "Authorization: Bearer $(cat /tmp/admin_secret_new.txt)" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

Auth passed — the failure that followed was the same `INTERNAL_ERROR`
shape as an earlier attempt, not an auth rejection, so it was initially
suspected to be a batch-size or CPU-time limit on the `test-ic` prefix's
`batch()` call (six DELETE statements against potentially thousands of
dependent rows, in one Workers request). `wrangler tail --format json`
was attached to get the real server-side error; the first attempt at
this produced no output (most likely the tail connection wasn't
established yet when the request fired), so it was redone with the tail
process started first in its own foreground terminal and the `curl`
fired as a second, separate step once tailing was confirmed live.

The real error, from production logs:

```
D1_ERROR: Your account has exceeded D1's free tier daily row read limit.
```

This is the **same quota** as the one behind the original `snapshot-persistence-plan.md`
§10 incident, now hit through the Worker binding path rather than the
CLI path. The dry-run's `SELECT COUNT(*)` scans across all 11 prefixes,
plus the failed delete's own query planning over the 399-row scope, were
enough to exhaust whatever budget remained on the Worker-binding side —
it is not a separate, independent quota from the CLI path; it is simply
a quota that hadn't been exhausted yet when this session's diagnostics
started. **Both paths (CLI and Worker binding) are now confirmed
exhausted together**, which contradicts the "two separate quotas" theory
noted as working in §4's design rationale and in the original §10
incident. That theory does not fully hold up and should be treated as
open, not settled, if it matters again.

Checking the current UTC time at the point of failure showed the daily
reset (00:00 UTC) had already passed — the new day's entire quota had
been burned through in under 17 minutes, entirely by diagnostics plus
one failed delete attempt. That is a strong signal the account's D1
free-tier budget is tight relative to what this cleanup needs: 399
companies × 6 dependent-table deletes each, on top of the dry-run's
11-prefix `COUNT(*)` scan, adds up in row reads even before counting the
actual deleted rows.

**Decision: stop for the day, resume after the next UTC reset.**
Retrying immediately would just fail again against the same wall.


## 7. Interaction with the KV mirror (§10)

The KV-mirror snapshot from the earlier same-day session
(`snapshotCapturedAt: 2026-09-03T23:30:43.351Z`) is still serving clean
data and holding fine as of this write-up. The 06:00 UTC reconciliation
cron will refresh that mirror from live D1 regardless of when the
cleanup eventually runs:

- If the cleanup completes **before** the next 06:00 UTC cron, the
  refreshed mirror will already be clean.
- If the cleanup completes **after** that cron, the cron will re-bake the
  still-present pollution into the mirror once more — but the day after
  that, once the mirror is refreshed again post-cleanup, it will be
  clean. This is a one-cycle delay, not a recurrence risk.

## 8. Next-session plan

After the next UTC midnight quota reset, one clean call should finish
this:

```bash
curl -X POST "https://hiring-signals-api.teycircoder14.workers.dev/api/v1/admin/test-data/cleanup" \
  -H "Authorization: Bearer $(cat /tmp/admin_secret_new.txt)" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

- **No dry-run needed first** — §3 already has the confirmed counts.
  Skipping the dry-run's 11-prefix `COUNT(*)` scan keeps this to a single
  route call instead of a dozen ad-hoc probes, which should stay well
  under whatever the daily row-read budget turns out to be.
- If `ADMIN_SECRET` needs to be re-set for any reason, use the piped form
  from §5 with the explicit environment flag:
  `cat /tmp/admin_secret_new.txt | npx wrangler secret put ADMIN_SECRET --env=""`.
- If the same `D1_ERROR` recurs even on a single confirmed call, that
  would mean the 399-company delete alone exceeds one full day's quota —
  worth knowing, and would justify chunking the cleanup by prefix across
  multiple days (largest first: `test-ic` at 117, `test-jrp` at 62,
  `test-swr` at 50, ...) rather than treating this as a one-shot
  operation going forward.
- After a successful `confirm: true` run, verify `totalMatchedCompanies`
  in the response reads `0` on a follow-up dry-run call, and spot-check
  `/api/v1/signals` for absence of `test-*` slugs the same way §1's
  discovery call surfaced them originally.

## 9. Related documents

- `snapshot-persistence-plan.md` §10 — the KV-mirror fallback added the
  same day as the original D1-quota incident this document is a
  follow-on to. That fix addresses *reads* going degraded during D1
  outages; this document addresses *writes* (test fixtures) left behind
  by the same outage.
- `apps/api/src/routes/admin.ts` — cleanup route source, including the
  full prefix allow-list and inline design rationale referenced in §4.
