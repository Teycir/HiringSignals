import { defineCommand } from "citty";
import { signalsQuerySchema } from "@hiring-signals/domain";
import { buildFeedUrl, resolveConfig } from "../api-client";

/**
 * `hs feed-url [filters]` -- prints the GET /api/v1/feed.rss URL for the
 * given filters (Milestone R.3, ROADMAP.md). Top-level command, not
 * nested under an existing parent -- same flat placement as `hs facets`.
 *
 * No network call: this only builds and prints a URL string. Reuses
 * `hs signals list`'s (F.1.2) flag set/validation (signalsQuerySchema,
 * same `.omit()` as `hs export signals` since the feed route accepts no
 * sort/cursor/limit either) rather than a second copy of flag parsing --
 * same reasoning as export.ts's own header comment: one schema, so a new
 * filter field only has to be added once and every command that reads
 * signals picks it up.
 *
 * Output: `{"url": "..."}` per F.1 design principle 1 (JSON on stdout by
 * default) -- an agent handing this to a person can extract `.url` and
 * pass the bare string to them for pasting into a feed reader.
 */
export const feedUrlCommand = defineCommand({
  meta: { name: "feed-url", description: "Print the RSS feed URL for the given filters." },
  args: {
    role: { type: "string", description: "Comma-separated role categories" },
    company: { type: "string", description: "Company slug or name filter" },
    q: { type: "string", description: "Keyword/semantic search query" },
    locationMode: { type: "string", description: "remote|hybrid|onsite|unknown" },
    country: { type: "string", description: "2-letter ISO country code" },
    source: { type: "string", description: "ATS provider" },
    signalType: { type: "string", description: "Signal type filter" },
    minScore: { type: "string", description: "Minimum score 0-100" },
    observedSince: { type: "string", description: "ISO-8601 datetime lower bound" },
  },
  async run({ args }) {
    const filterSchema = signalsQuerySchema.omit({ sort: true, cursor: true, limit: true });
    const parsed = filterSchema.parse({
      roles: args.role,
      company: args.company,
      q: args.q,
      locationMode: args.locationMode,
      country: args.country,
      source: args.source,
      signalType: args.signalType,
      minScore: args.minScore,
      observedSince: args.observedSince,
    });
    const url = buildFeedUrl(resolveConfig(), parsed);
    process.stdout.write(JSON.stringify({ url }) + "\n");
  },
});
