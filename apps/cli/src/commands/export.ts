import { writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { signalsQuerySchema } from "@hiring-signals/domain";
import { fetchSignalsCsv, resolveConfig } from "../api-client";

/**
 * `hs export signals [filters] [--out <path>]` -- GET
 * /api/v1/export/signals.csv (ROADMAP.md Milestone L.1, spec 9.2).
 *
 * The one command in this CLI whose stdout is deliberately NOT JSON when
 * --out is omitted: this route's own contract is CSV (spec's export
 * artifact format), and F.1's principle 1 ("JSON on stdout by default")
 * describes this CLI's own envelope around *API responses* -- it doesn't
 * mean re-wrapping a route that was never JSON to begin with. An agent
 * piping this into a file or a CSV-aware tool gets the same bytes
 * apps/api's own route would return over plain HTTP.
 *
 * Same filters as `hs signals list` minus sort/cursor/limit (export is a
 * capped single dump, not paginated -- see apps/api/src/routes/export.ts's
 * own header comment for why the two schemas are intentionally separate).
 */
const signals = defineCommand({
  meta: { name: "signals", description: "Export signals matching filters as CSV." },
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
    out: { type: "string", description: "File path to write CSV to; omit to print to stdout" },
  },
  async run({ args }) {
    // Reuse signalsQuerySchema for validation even though this route
    // doesn't accept sort/cursor/limit -- .omit() keeps the two schemas
    // provably in sync on every field they DO share, rather than
    // hand-copying validation rules a second time.
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
    const csv = await fetchSignalsCsv(resolveConfig(), parsed);
    if (args.out) {
      await writeFile(args.out, csv, "utf8");
      process.stdout.write(JSON.stringify({ data: { written: true, path: args.out, bytes: Buffer.byteLength(csv, "utf8") } }) + "\n");
    } else {
      process.stdout.write(csv);
    }
  },
});

export const exportCommand = defineCommand({
  meta: { name: "export", description: "Export data as CSV." },
  subCommands: { signals },
});
