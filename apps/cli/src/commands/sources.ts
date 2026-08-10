import { defineCommand } from "citty";
import { fetchSources, resolveConfig, type SourceListResponse, type SourceSummary } from "../api-client";
import { printResult, renderTable, type TableColumn } from "../output";

const SOURCE_LIST_COLUMNS: TableColumn<SourceSummary>[] = [
  { header: "PROVIDER", value: (s) => s.provider },
  { header: "COMPANY", value: (s) => s.companyId },
  { header: "ENABLED", value: (s) => (s.enabled ? "yes" : "no") },
  { header: "FAILURES", value: (s) => String(s.consecutiveFailures) },
  { header: "LAST SUCCESS", value: (s) => s.lastSuccessAt ?? "never" },
];

function renderSourceListTable(result: SourceListResponse): string {
  return renderTable(result.data, SOURCE_LIST_COLUMNS);
}

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
    printResult(result, renderSourceListTable);
  },
});

export const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "Read ingestion sources." },
  subCommands: { list },
});
