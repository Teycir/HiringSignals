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
`--min-score`, `--observed-since`, `--sort`, `--cursor`, `--limit`.

```
$ hs signals list --role software_engineering --limit 2
{"data":[{"id":"dca2de52-909f-5a66-85c8-e00b34891d52","companyId":"f6d212bb-0fb1-4137-9a1f-5fc23d066d3c","companySlug":"northwind-analytics","companyDisplayName":"Northwind Analytics","roleCategory":"software_engineering","signalType":"new_job","status":"active","score":33,"scoreVersion":"v1","firstDetectedAt":"2026-07-26T12:00:00Z","lastDetectedAt":"2026-07-27T10:00:00Z","expiresAt":null,"headline":"New Software Engineering role posted","summary":"A new Software Engineering position (\"Senior Software Engineer\") was posted and detected as a fresh listing.","canonicalUrl":null,"locationMode":null,"countryCode":null,"sourcePlatform":null}],"meta":{"requestId":"req_57d624e6-5559-4993-83e9-4e307434c9ba","appliedFilters":{"roles":["software_engineering"],"minScore":0,"sort":"score_desc","limit":2},"nextCursor":null,"searchMode":"keyword"}}
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
{"data":[{"id":"579a799b-a8d3-49d9-a0d5-4a326ab2a27f","slug":"gitlab","displayName":"GitLab","domain":null,"industry":null,"employeeBand":null}],"meta":{"requestId":"req_e8dd589e-fd23-476a-8970-835c5c474ca9","appliedFilters":{"q":"git","limit":2}}}
```

## `hs companies get <slug>`

Positional arg: `slug` (company slug, not UUID).

```
$ hs companies get gitlab
{"data":{"id":"579a799b-a8d3-49d9-a0d5-4a326ab2a27f","slug":"gitlab","displayName":"GitLab","domain":null,"industry":null,"employeeBand":null,"recentSignals":[{"id":"e393c6d4-90db-4097-989d-624e7891ff40","roleCategory":"ai_machine_learning","signalType":"hiring_burst","score":90,"headline":"Hiring burst: Engineering Manager, AI Engineering: Chat","lastDetectedAt":"2026-08-07T02:24:10.033Z"}]},"meta":{"requestId":"req_c3925d17-876e-4086-a7c3-28753dd7f333"}}
```

## `hs sources list [--company-id --limit]`

```
$ hs sources list --limit 2
{"data":[{"id":"33cf6e24-e152-41ab-9ac9-7480ef3ea51d","companyId":"ca4f6a63-828b-4fc8-abd4-374a7f816f2b","provider":"ashby","publicUrl":"https://jobs.ashbyhq.com/ramp","enabled":true,"pollIntervalMinutes":360,"lastSuccessAt":"2026-08-07T02:37:34.561Z","consecutiveFailures":0}],"meta":{"requestId":"req_43b52c7e-cb82-40bc-96bc-add90ee1d9d4","appliedFilters":{"limit":2}}}
```

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
