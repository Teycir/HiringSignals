import { defineCommand } from "citty";
import { ApiClientError, fetchCompanies, fetchCompanyDetail, fetchCompanyTimeline, resolveConfig, type CompanyListResponse } from "../api-client";
import type { RoleCategory } from "@hiring-signals/domain";
import { printResult, renderTable, type TableColumn } from "../output";
import type { CompanySummary } from "@hiring-signals/db/src/types";
import { loadWatchedCompanies, watchCompany, unwatchCompany } from "../config-store";

const COMPANY_LIST_COLUMNS: TableColumn<CompanySummary>[] = [
  { header: "NAME", value: (c) => c.displayName },
  { header: "SLUG", value: (c) => c.slug },
  { header: "INDUSTRY", value: (c) => c.industry ?? "" },
  { header: "VELOCITY", value: (c) => (c.hiringVelocityScore === null ? "" : String(c.hiringVelocityScore)) },
];

function renderCompanyListTable(result: CompanyListResponse): string {
  return renderTable(result.data, COMPANY_LIST_COLUMNS);
}

/** `hs companies list [--q --limit --watched]` -- GET /api/v1/companies
 * (spec 9.2, 10.4), or a local watchlist read when `--watched` is set.
 * `--watched` (feature request, spec P1 "Company watchlists") has no
 * server-side "watched" concept -- it's purely local config
 * (config-store.ts's `watchedCompanies`) -- so this path skips
 * fetchCompanies entirely and resolves each saved slug via a real
 * `fetchCompanyDetail` call instead, giving live data (velocity score,
 * recent signals) rather than a stale locally-cached snapshot. `--q` is
 * ignored when `--watched` is set (the two are different data sources,
 * not composable filters over one list) -- fine given `--q` has no
 * meaning against a fixed local slug list.
 *
 * Per-slug failures (stale/renamed/deleted watched slug -> NOT_FOUND)
 * are isolated with Promise.allSettled rather than Promise.all: one bad
 * slug in the watchlist must not take down the view for every other
 * company that would have succeeded. Successful lookups go in `data` as
 * before; failures are reported alongside in `meta.failures` (slug +
 * error code/message) rather than silently dropped, so a scripted agent
 * can still see and act on a stale watchlist entry -- this is the
 * per-item failure behavior `watch`'s own doc comment already describes
 * ("will simply surface a NOT_FOUND error at read time"), now actually
 * scoped to the one slug instead of the whole list.
 */
const list = defineCommand({
  meta: { name: "list", description: "Search/list companies." },
  args: {
    q: { type: "string", description: "Name search query (min 2 chars)" },
    limit: { type: "string", description: "Max results, 1-50 (default 20)" },
    watched: { type: "boolean", description: "List only companies on the local watchlist" },
  },
  async run({ args }) {
    if (args.watched) {
      const slugs = await loadWatchedCompanies();
      const config = resolveConfig();
      const settled = await Promise.allSettled(slugs.map((slug) => fetchCompanyDetail(config, slug)));

      const data: CompanySummary[] = [];
      const failures: { slug: string; code: string; message: string }[] = [];
      settled.forEach((outcome, i) => {
        const slug = slugs[i] as string;
        if (outcome.status === "fulfilled") {
          data.push(outcome.value.data);
        } else {
          const err = outcome.reason;
          if (err instanceof ApiClientError) {
            failures.push({ slug, code: err.code, message: err.message });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ slug, code: "UNKNOWN_ERROR", message });
          }
        }
      });

      const result: CompanyListResponse & { meta: { failures: typeof failures } } = {
        data,
        meta: {
          requestId: "req_local",
          appliedFilters: { watched: true },
          hiringVelocityDisclaimer:
            "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.",
          failures,
        },
      };
      printResult(result, renderCompanyListTable);
      return;
    }
    const result = await fetchCompanies(resolveConfig(), {
      q: args.q,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    printResult(result, renderCompanyListTable);
  },
});

/** `hs companies watch <slug>` -- adds a company slug to the local
 * watchlist (feature request, spec P1 "Company watchlists"). No API
 * call: purely local config-store.ts state. Idempotent -- watching an
 * already-watched slug is a no-op, not an error (matches this CLI's
 * existing "repeat operations are safe" posture, e.g.
 * clearSavedFilters). Does not validate the slug against the API
 * (no network call at all here) -- `hs companies list --watched` will
 * simply surface a NOT_FOUND error at read time for a bad slug, same
 * as `hs companies get` would, rather than this command needing its
 * own duplicate validation round trip -- see `list`'s own comment above
 * for how that NOT_FOUND is now scoped to just this slug. */
const watch = defineCommand({
  meta: { name: "watch", description: "Add a company to the local watchlist." },
  args: {
    slug: { type: "positional", description: "Company slug", required: true },
  },
  async run({ args }) {
    const watchedCompanies = await watchCompany(args.slug);
    printResult({ data: { watched: args.slug, watchedCompanies } });
  },
});

/** `hs companies unwatch <slug>` -- removes a company slug from the
 * local watchlist. No-op, not an error, if it wasn't watched. */
const unwatch = defineCommand({
  meta: { name: "unwatch", description: "Remove a company from the local watchlist." },
  args: {
    slug: { type: "positional", description: "Company slug", required: true },
  },
  async run({ args }) {
    const watchedCompanies = await unwatchCompany(args.slug);
    printResult({ data: { unwatched: args.slug, watchedCompanies } });
  },
});

/** `hs companies get <slug>` -- GET /api/v1/companies/:slug (spec 9.2,
 * 10.5). No table renderer: CompanyDetail nests a full `recentSignals`
 * array (SignalListItem[]) inside a single company object -- there's no
 * single-row flattening that doesn't either drop the signals or produce
 * one absurdly wide row; printResult() falls back to JSON with a stderr
 * note under --format table (use `hs signals list --company <slug>`
 * for a tabular view of that company's signals instead). */
const get = defineCommand({
  meta: { name: "get", description: "Get a company by slug, with recent signals." },
  args: {
    slug: { type: "positional", description: "Company slug", required: true },
  },
  async run({ args }) {
    const result = await fetchCompanyDetail(resolveConfig(), args.slug);
    printResult(result);
  },
});

/**
 * `hs companies timeline <slug> [--since --until --roles --bucket-days]`
 * -- GET /api/v1/companies/:slug/timeline (ROADMAP.md Milestone O.2,
 * spec §1.4/§10.1). Same params the endpoint accepts, flag names kept
 * kebab-case to match citty's default CLI convention (other commands in
 * this file use camelCase JS identifiers internally either way, so this
 * is purely a flag-surface naming choice, not a schema divergence --
 * `bucket-days` maps to `bucketDays` below before being sent).
 *
 * No table renderer: each bucket carries its own nested roleBreakdown/
 * locationBreakdown arrays (CompanyHiringTimelineBucket's own type
 * comment) -- same "no honest single-row flattening" reasoning as
 * `companies get` above, so this falls back to JSON under --format
 * table too rather than silently dropping the breakdown detail.
 */
const timeline = defineCommand({
  meta: { name: "timeline", description: "Company hiring timeline, time-bucketed (spec 1.4/10.1)." },
  args: {
    slug: { type: "positional", description: "Company slug", required: true },
    since: { type: "string", description: "ISO-8601 datetime, window start (default 90d ago)" },
    until: { type: "string", description: "ISO-8601 datetime, window end (default now)" },
    roles: { type: "string", description: "Single role category filter" },
    "bucket-days": { type: "string", description: "Bucket width: 7, 14, or 30 (default 14)" },
  },
  async run({ args }) {
    const result = await fetchCompanyTimeline(resolveConfig(), args.slug, {
      since: args.since,
      until: args.until,
      roles: args.roles as RoleCategory | undefined,
      bucketDays: args["bucket-days"]
        ? (Number(args["bucket-days"]) as 7 | 14 | 30)
        : undefined,
    });
    printResult(result);
  },
});

export const companiesCommand = defineCommand({
  meta: { name: "companies", description: "Read companies (spec 9.2)." },
  subCommands: { list, get, timeline, watch, unwatch },
});
