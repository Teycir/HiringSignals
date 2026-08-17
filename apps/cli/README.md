# @hiring-signals/cli

Thin JSON client over `apps/api`. No D1 access, no bypassing the API's
own validation/rate-limiting/auth. Every command prints exactly one JSON
value to stdout and nothing else, so `hs ... | jq .` always works.
Errors print exactly one JSON object to stderr and exit non-zero. No
interactive prompts, ever.

## Setup

```
HS_API_BASE_URL=http://localhost:8787   # default; override for a live/remote API
HS_ADMIN_SECRET=<secret>                # required only for `hs admin ...`
```

## Global flags

### `--format json|table`

Default is always `json` (one JSON value on stdout, nothing else, F.1 design principle 1).
`--format table` is available for interactive human-debugging convenience on flat-list
commands only. Add it before the subcommand:

```
$ hs --format table signals list --role software_engineering --limit 3
ID          COMPANY              ROLE                TYPE        SCORE  HEADLINE
----------  -------------------  ------------------  ----------  -----  ---------------------------------------------
dca2de52    Northwind Analytics  software_engineering  new_job    33     New Software Engineering role posted
...
```

Genuinely nested shapes (signal detail with evidence[], company detail with recentSignals[],
timeline buckets, feed-url output) decline table mode and fall back to JSON with a one-line
stderr note so you don't lose data — they have no honest single-row flattening.
`--format=table` (equals syntax) also works; unrecognized values fall back to `json` silently
rather than failing.

### `--version` / `-v`

Prints the installed `apps/cli` version (read live from `package.json`) to stdout and exits 0.
Only recognized when it's the sole argument, e.g. `hs --version` or `hs -v` — not
`hs signals list -v`, which passes `-v` through to `signals list` unchanged.

```
$ hs --version
1.0.0
```

## Error shape

Every non-zero exit prints exactly this to stderr, nothing else:

```json
{"error":{"code":"NOT_FOUND","message":"Company not found.","requestId":"req_..."}}
```

`code` is one of: a Zod validation failure serialized as `CLI_ERROR`
(local, no network call made), `NETWORK_ERROR` (host unreachable,
`requestId` is always `"req_none"`), `MISSING_ADMIN_SECRET` (admin
command run without `HS_ADMIN_SECRET`, local, no network call), or an
API-defined code (e.g. `NOT_FOUND`, `VALIDATION_ERROR`) parsed from the
API's own error envelope.

## `hs facets`

No flags.

```
$ hs facets
{"data":{"roles":[{"value":"ai_machine_learning","count":10},{"value":"cloud_platform_devops_sre","count":4}],"sources":[{"value":"greenhouse","count":1501},{"value":"ashby","count":160}],"locationModes":[{"value":"onsite","count":1275},{"value":"remote","count":319}]},"meta":{"requestId":"req_bb8eb98d-8b5b-4981-bccc-c9c0cdfaacd4","cached":false}}
```

## `hs signals list [flags]`

Flags: `--role` (singular flag name; comma-separated values, e.g.
`--role software_engineering,ai_machine_learning`), `--company`, `--q`,
`--location-mode`, `--country`, `--source`, `--signal-type`,
`--min-score`, `--observed-since`, `--sort`, `--cursor`, `--limit`,
`--watched` (see below), `--watch` (polling), `--save`/`--clear-saved`.

```
$ hs signals list --role software_engineering --limit 2
{"data":[{"id":"dca2de52-909f-5a66-85c8-e00b34891d52","companyId":"f6d212bb-0fb1-4137-9a1f-5fc23d066d3c","companySlug":"northwind-analytics","companyDisplayName":"Northwind Analytics","roleCategory":"software_engineering","signalType":"new_job","status":"active","score":33,"scoreVersion":"v2","firstDetectedAt":"2026-07-26T12:00:00Z","lastDetectedAt":"2026-07-27T10:00:00Z","expiresAt":null,"headline":"New Software Engineering role posted","summary":"A new Software Engineering position (\"Senior Software Engineer\") was posted and detected as a fresh listing.","canonicalUrl":null,"locationMode":null,"countryCode":null,"sourcePlatform":null}],"meta":{"requestId":"req_57d624e6-5559-4993-83e9-4e307434c9ba","appliedFilters":{"roles":["software_engineering"],"minScore":0,"sort":"score_desc","limit":2},"nextCursor":null,"searchMode":"keyword"}}
```

`--role` is singular even though it accepts a comma-separated list --
`--roles` is silently ignored by citty (unknown flag), producing an
unfiltered result set with no error. Always use `--role`.

### Saved filter profiles (`--save`, `--clear-saved`)

`--save` persists the given filter flags (not `--sort`/`--cursor`/
`--limit`) to a local config file so you don't have to re-type them
every invocation. Storage location: `~/.hiring-signals/config.json`, or
`$XDG_CONFIG_HOME/hiring-signals/config.json` if that env var is set.

```
$ hs signals list --role cybersecurity --save
{"data":[...],"meta":{...}}
```

With **no** filter flags and a saved profile present, `hs signals list`
applies it automatically and prints a one-line note to stderr (stdout
stays pure JSON):

```
$ hs signals list
Using saved filters: role=cybersecurity
{"data":[...],"meta":{...}}
```

Supplying any filter flag skips the saved profile entirely for that
invocation (no note printed). `--clear-saved` removes the saved profile:

```
$ hs signals list --clear-saved
{"data":{"clearedSaved":true}}
```

If the saved file is missing, corrupt, or fails validation, it's
silently discarded and the command proceeds unfiltered -- no error, no
prompt.

### Watchlist filter (`--watched`)

`--watched` scopes results to the companies in your local watchlist
(the same `~/.hiring-signals/config.json` list `hs companies watch
<slug>` / `hs companies unwatch <slug>` manage). Because `--company`
is a single server-side value, `--watched` fans out one API request
per watched slug (applying every other filter flag to each) and
merges the results client-side, re-sorting the merged set by the same
`--sort` and truncating to `--limit`.

```
$ hs companies watch gitlab
$ hs companies watch stripe
$ hs signals list --watched --min-score 50
{"data":[...],"meta":{...,"appliedFilters":{"watched":true,...},"failures":[]}}
```

Notes:
- **`--watched` overrides `--company`** if both are given (matches
  `hs companies list --watched`'s existing precedent for `--q`) --
  the company scope can't come from two places at once.
- **`--cursor` is silently ignored** under `--watched`: a single
  server-side page token is meaningless once N per-company requests
  are merged client-side. `--limit` still applies, as a per-company
  cap before the merge.
- **Per-slug failures are isolated**, not fatal -- one unreachable or
  renamed watched company is reported in `meta.failures` (each entry:
  `slug`, `code`, `message`) rather than failing the whole command.
- **Empty watchlist succeeds trivially** with an empty result set and
  no API call, same as `hs companies list --watched`.
- **Composes with `--watch` (polling)** -- each tick re-fans-out
  across the current watchlist.
- **Not saveable** -- `--watched` is a data-source selector, not a
  filter value, so `--save` never persists it (same reasoning as
  `--q` under `companies list --watched`).

## `hs signals get <signalId>`

Positional arg: `signalId` (UUID).

```
$ hs signals get dca2de52-909f-5a66-85c8-e00b34891d52
{"data":{"id":"dca2de52-909f-5a66-85c8-e00b34891d52","companyId":"f6d212bb-0fb1-4137-9a1f-5fc23d066d3c","companySlug":"northwind-analytics","companyDisplayName":"Northwind Analytics","roleCategory":"software_engineering","signalType":"new_job","status":"active","score":33,"scoreVersion":"v1","firstDetectedAt":"2026-07-26T12:00:00Z","lastDetectedAt":"2026-07-27T10:00:00Z","expiresAt":null,"headline":"New Software Engineering role posted","summary":"A new Software Engineering position (\"Senior Software Engineer\") was posted and detected as a fresh listing.","canonicalUrl":null,"locationMode":null,"countryCode":null,"sourcePlatform":null,"lastSourceRunAt":null,"evidence":[]},"meta":{"requestId":"req_e67750fb-fa7a-4722-8a22-6e04bb936971"}}
```

`evidence` is `[]` when the signal has no associated evidence rows yet;
`lastSourceRunAt` is `null` until the source's first successful run.

## `hs companies list [--q --limit]`

```
$ hs companies list --q git --limit 2
{"data":[{"id":"579a799b-a8d3-49d9-a0d5-4a326ab2a27f","slug":"gitlab","displayName":"GitLab","domain":null,"industry":null,"employeeBand":null,"hiringVelocityScore":72,"velocityComputedAt":"2026-08-14T06:00:00Z"}],"meta":{"requestId":"req_e8dd589e-fd23-476a-8970-835c5c474ca9","appliedFilters":{"q":"git","limit":2},"hiringVelocityDisclaimer":"Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget."}}
```

`hiringVelocityScore` is 0–100; `null`/uncomputed companies sort last in `trends hiring` results. The shared disclaimer constant is surfaced in `meta.hiringVelocityDisclaimer` on every companies/trends response (spec §11.3).

## `hs companies timeline <slug> [--since --until --roles --bucket-days]`

Time-bucketed hiring activity for one company, queryable by role + date range.
No table renderer (each bucket has nested `roleBreakdown`/`locationBreakdown` arrays);
declines `--format table` and falls back to JSON with a stderr note.

Flags:
- `since` / `until`: ISO-8601 datetimes (window defaults to last 90 days; window capped at 90 days, exceeding returns 400)
- `roles`: single role category filter
- `--bucket-days`: 7, 14, or 30 (default 14)

```
$ hs companies timeline gitlab --bucket-days 14 --limit 2
{"data":{"company":{"id":"579a799b-a8d3-49d9-a0d5-4a326ab2a27f","slug":"gitlab","displayName":"GitLab","hiringVelocityScore":72,"velocityComputedAt":"2026-08-14T06:00:00Z"},"buckets":[{"bucketStart":"2026-07-18T00:00:00Z","bucketEnd":"2026-07-31T23:59:59Z","newJobsCount":4,"closedJobsCount":1,"activeJobsCount":12,"roleBreakdown":[{"roleCategory":"software_engineering","count":8},{"roleCategory":"ai_machine_learning","count":4}],"locationBreakdown":[{"countryCode":"US","count":7},{"countryCode":null,"count":5}],"signalTypes":["hiring_burst","multi_location"]},{"bucketStart":"2026-08-01T00:00:00Z","bucketEnd":"2026-08-14T23:59:59Z","newJobsCount":2,"closedJobsCount":0,"activeJobsCount":14,"roleBreakdown":[{"roleCategory":"ai_machine_learning","count":7}],"locationBreakdown":[{"countryCode":"US","count":9}],"signalTypes":["role_acceleration"]}]},"meta":{"requestId":"req_2b7b6c1a-2b7b-6c1a-2b7b-6c1a2b7b6c1a","appliedFilters":{"bucketDays":14}}}
```

## `hs companies get <slug>`

Positional arg: `slug` (company slug, not UUID).

```
$ hs companies get gitlab
{"data":{"id":"579a799b-a8d3-49d9-a0d5-4a326ab2a27f","slug":"gitlab","displayName":"GitLab","domain":null,"industry":null,"employeeBand":null,"hiringVelocityScore":72,"velocityComputedAt":"2026-08-14T06:00:00Z","recentSignals":[{"id":"e393c6d4-90db-4097-989d-624e7891ff40","roleCategory":"ai_machine_learning","signalType":"hiring_burst","score":90,"headline":"Hiring burst: Engineering Manager, AI Engineering: Chat","lastDetectedAt":"2026-08-07T02:24:10.033Z"}]},"meta":{"requestId":"req_c3925d17-876e-4086-a7c3-28753dd7f333","hiringVelocityDisclaimer":"Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget."}}
```

## `hs sources list [--company-id --limit]`

```
$ hs sources list --limit 2
{"data":[{"id":"33cf6e24-e152-41ab-9ac9-7480ef3ea51d","companyId":"ca4f6a63-828b-4fc8-abd4-374a7f816f2b","provider":"ashby","publicUrl":"https://jobs.ashbyhq.com/ramp","enabled":true,"pollIntervalMinutes":360,"lastSuccessAt":"2026-08-07T02:37:34.561Z","consecutiveFailures":0}],"meta":{"requestId":"req_43b52c7e-cb82-40bc-96bc-add90ee1d9d4","appliedFilters":{"limit":2}}}
```

## `hs feed-url [flags]`

Builds a working RSS feed URL (`GET /api/v1/feed.rss`) from the same signal
filter flags as `hs signals list`. Copy the resulting URL into any feed reader
(Feedly, NetNewsWire, etc.) for push-style alerts.

Flags match `hs signals list`: `--role`, `--company`, `--q`, `--location-mode`,
`--country`, `--source`, `--signal-type`, `--min-score`, `--observed-since`.
`--sort`/`--cursor`/`--limit` are never present (feed is always newest-first
at 50-item cap).

```
$ hs feed-url --role cybersecurity --country US --min-score 70
{"url":"http://localhost:8787/api/v1/feed.rss?roles=cybersecurity&country=US&minScore=70"}
```

Always one JSON object on stdout. No table renderer; feed discovery is a
one-value result, and piping the JSON through `| jq -r .url` is the intended
agent pattern.

## `hs trends hiring --role <roles> [flags]`

Cross-company ranked hiring trends — "which fintechs started hiring ML in the last 60d?"
Mirrors `GET /api/v1/trends/hiring`. Table renderer available (flat list).

Flags:
- `--role`: comma-delimited role categories (required, >=1)
- `--industry`: free-text industry filter
- `--country`: 2-letter ISO country code
- `--since`: ISO-8601 datetime, window start (default 30d ago)
- `--sort`: `acceleration_desc` | `volume_desc` | `newest_signal` | `velocity_desc` (default `acceleration_desc`)
- `--limit`: 1–50 (default 20)

```
$ hs trends hiring --role ai_machine_learning --industry fintech --sort velocity_desc --limit 3
{"data":[{"company":{"slug":"northwind-analytics","displayName":"Northwind Analytics","industry":"fintech"},"newJobsCount":7,"activeJobsCount":18,"acceleration":2.11,"hiringVelocityScore":89,"topLocations":[{"countryCode":"US","count":12},{"countryCode":"DE","count":4}],"latestSignalType":"hiring_burst","latestSignalAt":"2026-08-14T02:15:00Z"},{"company":{"slug":"acme-fintech","displayName":"Acme Fintech","industry":"fintech"},"newJobsCount":3,"activeJobsCount":11,"acceleration":1.33,"hiringVelocityScore":64,"topLocations":[{"countryCode":"GB","count":9}],"latestSignalType":"role_acceleration","latestSignalAt":"2026-08-13T06:40:00Z"},{"company":{"slug":"globex-pay","displayName":"Globex Pay","industry":"fintech"},"newJobsCount":1,"activeJobsCount":5,"acceleration":0.50,"hiringVelocityScore":null,"topLocations":[{"countryCode":null,"count":5}],"latestSignalType":"new_job","latestSignalAt":"2026-08-12T11:20:00Z"}],"meta":{"requestId":"req_8a2a9c1b-3d4e-5f6a-7b8c-9d0e1f2a3b4c","appliedFilters":{"roles":["ai_machine_learning"],"industry":"fintech","sort":"velocity_desc","limit":3},"hiringVelocityDisclaimer":"Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget."}}
```

`hiringVelocityScore` of `null` means the company hasn't been scored yet (never reconciled); it sorts LAST in `velocity_desc` (never implicitly ranked as 0).

## `hs export signals [filters] [--out <path>]`

Same filters as `signals list` minus `--sort`/`--cursor`/`--limit`
(export is a capped single dump, not paginated). The one command whose
stdout is raw CSV, not a JSON envelope, when `--out` is omitted --
piping through `jq` will fail on purpose here. With `--out`, writes the
file and prints a small JSON confirmation instead.

```
$ hs export signals --role software_engineering
signal_id,signal_type,score,company_name,role_category,headline,location_mode,country_code,first_detected_at,last_detected_at,source_platform,canonical_url
dca2de52-909f-5a66-85c8-e00b34891d52,new_job,33,Northwind Analytics,software_engineering,New Software Engineering role posted,,,2026-07-26T12:00:00Z,2026-07-27T10:00:00Z,,
```

```
$ hs export signals --role software_engineering --out /tmp/signals.csv
{"data":{"written":true,"path":"/tmp/signals.csv","bytes":214}}
```

## `hs admin source run <sourceId> --yes`

Requires `HS_ADMIN_SECRET`. `--yes` is mandatory -- omitting it fails
locally (`CLI_ERROR`-style, no network call) rather than prompting.

```
$ hs admin source run 33cf6e24-e152-41ab-9ac9-7480ef3ea51d --yes
{"data":{"enqueued":true,"sourceId":"33cf6e24-e152-41ab-9ac9-7480ef3ea51d","runId":"8a206439-8fa1-46d8-8924-48cf18363091","companyId":"ca4f6a63-828b-4fc8-abd4-374a7f816f2b","provider":"ashby","requestedAt":"2026-08-07T21:40:13.672Z"},"meta":{"requestId":"req_3988ea65-04d9-400d-8128-2d2e7190156d"}}
```

## `hs admin scheduler flush --yes`

Requires `HS_ADMIN_SECRET` and `--yes`.

```
$ hs admin scheduler flush --yes
{"data":{"flushed":true,"scheduledAt":"2026-08-07T21:40:02.184Z","batchLimit":200,"note":"Enqueues up to 200 due sources per flush; repeat for remainder or wait for the cron."},"meta":{"requestId":"req_795709d5-3f6a-4489-bd1e-d4f3e6769c84"}}
```

## `hs admin reconcile --yes`

Requires `HS_ADMIN_SECRET` and `--yes`.

```
$ hs admin reconcile --yes
{"data":{"reconciled":true,"startedAt":"2026-08-07T21:40:07.550Z","batchLimit":200,"note":"Reconciles up to 200 stale signals per run; repeat for remainder or wait for the daily cron."},"meta":{"requestId":"req_78cea87d-83ab-41ad-806a-2d658515ba20"}}
```

## Tests

`pnpm --filter @hiring-signals/cli test` -- `test/api-client.test.ts`
(mocked `fetch`, no live server needed), `test/cli-process.test.ts` and
`test/signals-list-saved-filters.test.ts` (real subprocess spawns of
`bin/hs.mjs`, asserting exit codes and the single-JSON-object stderr
contract), `test/feed-url.test.ts` and `test/config-store.test.ts` (pure
logic / real temp-dir filesystem I/O, no network). None of these suites
depend on `wrangler dev` being up.
