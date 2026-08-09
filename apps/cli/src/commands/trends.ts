import { defineCommand } from "citty";
import { fetchHiringTrends, resolveConfig } from "../api-client";
import type { RoleCategory } from "@hiring-signals/domain";

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
 * No `--format table` (F.1.1 dropped that flag CLI-wide, see that
 * milestone's own scope note, and `hs companies timeline`/O.2 follows
 * the same convention) -- output is always the raw JSON envelope P.2's
 * route returns, for an agent to filter/re-rank further itself. This
 * corrects ROADMAP.md's P.3 section, which still sketches a
 * `--format table` renderer as a live plan; that was already superseded
 * by F.1.1's JSON-only decision before this command was ever built.
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
      description: "acceleration_desc | volume_desc | newest_signal (default acceleration_desc)",
    },
    limit: { type: "string", description: "Max results, 1-50 (default 20)" },
  },
  async run({ args }) {
    const result = await fetchHiringTrends(resolveConfig(), {
      roles: args.role
        ? (args.role.split(",").map((r) => r.trim()) as RoleCategory[])
        : undefined,
      industry: args.industry,
      country: args.country,
      since: args.since,
      sort: args.sort as "acceleration_desc" | "volume_desc" | "newest_signal" | undefined,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

export const trendsCommand = defineCommand({
  meta: { name: "trends", description: "Cross-company hiring trend analytics (spec 1.2/2.3)." },
  subCommands: { hiring },
});
