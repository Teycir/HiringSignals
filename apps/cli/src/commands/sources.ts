import { defineCommand } from "citty";
import { fetchSources, resolveConfig } from "../api-client";

/** `hs sources list [--company-id --limit]` -- GET /api/v1/sources. */
const list = defineCommand({
  meta: { name: "list", description: "List ingestion sources." },
  args: {
    companyId: { type: "string", description: "Filter to one company's sources (UUID)" },
    limit: { type: "string", description: "Max results, 1-100 (default 20)" },
  },
  async run({ args }) {
    const result = await fetchSources(resolveConfig(), {
      companyId: args.companyId,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

export const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "Read ingestion sources." },
  subCommands: { list },
});
