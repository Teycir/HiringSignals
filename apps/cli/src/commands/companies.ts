import { defineCommand } from "citty";
import { fetchCompanies, fetchCompanyDetail, fetchCompanyTimeline, resolveConfig, type CompanyListResponse } from "../api-client";
import type { RoleCategory } from "@hiring-signals/domain";
import { printResult, renderTable, type TableColumn } from "../output";
import type { CompanySummary } from "@hiring-signals/db/src/types";

const COMPANY_LIST_COLUMNS: TableColumn<CompanySummary>[] = [
  { header: "NAME", value: (c) => c.displayName },
  { header: "SLUG", value: (c) => c.slug },
  { header: "INDUSTRY", value: (c) => c.industry ?? "" },
  { header: "VELOCITY", value: (c) => (c.hiringVelocityScore === null ? "" : String(c.hiringVelocityScore)) },
];

function renderCompanyListTable(result: CompanyListResponse): string {
  return renderTable(result.data, COMPANY_LIST_COLUMNS);
}

/** `hs companies list [--q --limit]` -- GET /api/v1/companies (spec 9.2, 10.4). */
const list = defineCommand({
  meta: { name: "list", description: "Search/list companies." },
  args: {
    q: { type: "string", description: "Name search query (min 2 chars)" },
    limit: { type: "string", description: "Max results, 1-50 (default 20)" },
  },
  async run({ args }) {
    const result = await fetchCompanies(resolveConfig(), {
      q: args.q,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    printResult(result, renderCompanyListTable);
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
  subCommands: { list, get, timeline },
});
