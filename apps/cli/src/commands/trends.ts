import { defineCommand } from "citty";
import { fetchHiringTrends, resolveConfig, type HiringTrendsResponse } from "../api-client";
import { trendsQuerySchema } from "@hiring-signals/domain";
import { printResult, renderTable, type TableColumn } from "../output";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";

/** topLocations is dropped from the table view (same "flat columns
 * only, full detail stays in JSON" convention as signals.ts's
 * SIGNAL_LIST_COLUMNS) -- every other field here is already flat or a
 * one-level company.field projection, so this list IS honestly
 * table-able, unlike companies get/timeline's genuinely nested shapes. */
const TRENDS_COLUMNS: TableColumn<HiringTrendCompany>[] = [
  { header: "COMPANY", value: (t) => t.company.displayName },
  { header: "NEW JOBS", value: (t) => String(t.newJobsCount) },
  { header: "ACTIVE", value: (t) => String(t.activeJobsCount) },
  { header: "ACCELERATION", value: (t) => t.acceleration.toFixed(2) },
  { header: "VELOCITY", value: (t) => (t.hiringVelocityScore === null ? "" : String(t.hiringVelocityScore)) },
  { header: "LATEST SIGNAL", value: (t) => t.latestSignalType ?? "" },
];

function renderTrendsTable(result: HiringTrendsResponse): string {
  return renderTable(result.data, TRENDS_COLUMNS);
}

/**
 * `hs trends hiring --role backend [--industry --country --since --sort
 * --limit]` -- GET /api/v1/trends/hiring (ROADMAP.md Milestone P.2/P.3,
 * spec §1.2/§2.3). Same params the endpoint accepts. `--role` accepts a
 * comma-delimited list (matching the route's own `roles` param name and
 * queryFromRecord's array-join serialization, same convention `hs
 * signals list --role` already uses per F.1.2) -- flag kept singular
 * "role" for CLI-surface consistency with that sibling command, even
 * though the wire param is plural `roles`.
 *
 * Bug found in review: this command used to hand-roll its own
 * `args.role.split(",")` instead of validating through
 * trendsQuerySchema (@hiring-signals/domain) the way every sibling
 * command (signals list, export, feed-url, companies timeline) routes
 * its flags through the one real schema before ever calling the API.
 * That meant an invalid role category, a missing `--role` (this
 * endpoint's own schema marks `roles` required, >=1 -- see
 * trends-query.ts's header comment), a trailing-comma empty segment
 * (`--role backend,`), an out-of-range `--limit`, or a malformed
 * `--since` all silently reached the network instead of failing
 * locally with a clear Zod error -- exactly the "bad value fails
 * locally instead of round-tripping to the API first" contract this
 * CLI's own signals.ts docstring describes. Now parses through
 * trendsQuerySchema.parse() like every other command, so a bad value
 * here behaves identically to `hs signals list --role backend` (an
 * invalid role) already does.
 *
 * `--format table` (spec §16.2) is now implemented CLI-wide (this
 * comment previously said F.1.1 dropped it; that scope note has been
 * corrected in ROADMAP.md's G.5 section -- it was an undocumented gap,
 * not a real decision, per F.1.1's own "add a subtask if a human
 * debugging by hand turns out to need it").
 */
const hiring = defineCommand({
  meta: { name: "hiring", description: "Cross-company hiring trends, ranked (spec 1.2/2.3)." },
  args: {
    role: { type: "string", description: "Comma-delimited role categories (required, >=1)" },
    industry: { type: "string", description: "Free-text industry filter" },
    country: { type: "string", description: "2-letter ISO country code" },
    since: { type: "string", description: "ISO-8601 datetime, window start (default 30d ago)" },
    sort: {
      type: "string",
      description:
        "acceleration_desc | volume_desc | newest_signal | velocity_desc (default acceleration_desc)",
    },
    limit: { type: "string", description: "Max results, 1-50 (default 20)" },
  },
  async run({ args }) {
    const parsed = trendsQuerySchema.parse({
      roles: args.role,
      industry: args.industry,
      country: args.country,
      since: args.since,
      sort: args.sort,
      limit: args.limit,
    });
    const result = await fetchHiringTrends(resolveConfig(), parsed);
    printResult(result, renderTrendsTable);
  },
});

export const trendsCommand = defineCommand({
  meta: { name: "trends", description: "Cross-company hiring trend analytics (spec 1.2/2.3)." },
  subCommands: { hiring },
});
