import { defineCommand } from "citty";
import { signalsQuerySchema } from "@hiring-signals/domain";
import { fetchSignals, fetchSignalDetail, resolveConfig, type SignalListResponse } from "../api-client";
import {
  loadSavedFilters,
  saveFilters,
  clearSavedFilters,
  hasAnyFilter,
  type SavedFilterFlags,
} from "../config-store";
import { printResult, renderTable, truncate, type TableColumn } from "../output";
import type { SignalListItem } from "@hiring-signals/db/src/types";

const FILTER_FLAG_KEYS = [
  "role",
  "company",
  "q",
  "locationMode",
  "country",
  "source",
  "signalType",
  "minScore",
  "observedSince",
] as const;

function pickFilterFlags(args: Record<string, unknown>): SavedFilterFlags {
  const out: SavedFilterFlags = {};
  for (const key of FILTER_FLAG_KEYS) {
    const value = args[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Columns picked for `--format table` scannability, not completeness --
 * a human eyeballing results wants score/company/role/headline at a
 * glance, not every SignalListItem field (scoreVersion, expiresAt,
 * canonicalUrl, etc. are still in the JSON, just not this table; `hs
 * signals get <id>` is the drill-down for full detail). headline is
 * truncated (see output.ts's truncate() comment) since it's the field
 * most likely to blow out column width otherwise.
 */
const SIGNAL_LIST_COLUMNS: TableColumn<SignalListItem>[] = [
  { header: "SCORE", value: (s) => String(s.score) },
  { header: "COMPANY", value: (s) => s.companyDisplayName },
  { header: "ROLE", value: (s) => s.roleCategory },
  { header: "TYPE", value: (s) => s.signalType },
  { header: "STATUS", value: (s) => s.status },
  { header: "HEADLINE", value: (s) => truncate(s.headline, 60) },
];

function renderSignalListTable(result: SignalListResponse): string {
  const table = renderTable(result.data, SIGNAL_LIST_COLUMNS);
  const cursorNote = result.meta.nextCursor
    ? `\n(more results -- pass --cursor ${result.meta.nextCursor} for the next page)`
    : "";
  return table + cursorNote;
}

/**
 * `hs signals list [flags]` -- GET /api/v1/signals (spec 9.2/9.3).
 * Flags mirror signalsQuerySchema (@hiring-signals/domain) 1:1; the schema
 * itself does the validation (F.1.1 decision -- same contract the API
 * enforces, imported not re-declared). citty's args block below exists
 * only to describe the flags for --help / usage text and to tell citty
 * they're strings on the wire -- signalsQuerySchema.parse() still does
 * the real coercion/validation (z.coerce.number(), enum checks, etc.)
 * before anything is sent, so a bad value fails locally with a clear
 * message instead of round-tripping to the API first.
 *
 * Saved filter profiles (ROADMAP.md Milestone N.1): `--save` persists the
 * current filter flags (not sort/cursor/limit -- those are per-invocation
 * concerns, not part of "my usual role/location search") to a local config
 * file via config-store.ts. `--clear-saved` removes it. With NO filter
 * flags supplied and a saved profile present, the saved profile is applied
 * automatically -- a CLI has no URL to treat as source of truth the way a
 * browser tab does, so "no flags supplied" is the CLI's equivalent of "no
 * URL params." A one-line stderr note makes this visible rather than
 * silent, since there's no banner UI to show it in otherwise.
 */
const list = defineCommand({
  meta: { name: "list", description: "List signals matching filters." },
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
    sort: { type: "string", description: "score_desc|newest|company_asc" },
    cursor: { type: "string", description: "Pagination cursor from a prior response" },
    limit: { type: "string", description: "Page size, 1-100" },
    save: { type: "boolean", description: "Save the given filter flags as the default profile" },
    clearSaved: { type: "boolean", description: "Remove the saved filter profile" },
  },
  async run({ args }) {
    if (args.clearSaved) {
      await clearSavedFilters();
      printResult({ data: { clearedSaved: true } });
      return;
    }

    let filterFlags = pickFilterFlags(args as unknown as Record<string, unknown>);

    if (args.save) {
      await saveFilters(filterFlags);
    } else if (!hasAnyFilter(filterFlags)) {
      const saved = await loadSavedFilters();
      if (saved) {
        filterFlags = saved;
        const summary = Object.entries(saved)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        process.stderr.write(`Using saved filters: ${summary}\n`);
      }
    }

    const parsed = signalsQuerySchema.parse({
      roles: filterFlags.role,
      company: filterFlags.company,
      q: filterFlags.q,
      locationMode: filterFlags.locationMode,
      country: filterFlags.country,
      source: filterFlags.source,
      signalType: filterFlags.signalType,
      minScore: filterFlags.minScore,
      observedSince: filterFlags.observedSince,
      sort: args.sort,
      cursor: args.cursor,
      limit: args.limit,
    });
    const result = await fetchSignals(resolveConfig(), parsed);
    printResult(result, renderSignalListTable);
  },
});

/** `hs signals get <signalId>` -- GET /api/v1/signals/:signalId (spec
 * 10.5). No table renderer: SignalDetail's `evidence` array has its own
 * nested shape (payload is per-evidence-type unstructured JSON, see
 * SignalDetail's own type comment) with no honest single-row-per-signal
 * flattening -- printResult() falls back to JSON with a stderr note
 * under --format table rather than mangling or silently dropping it. */
const get = defineCommand({
  meta: { name: "get", description: "Get a single signal by id, with evidence." },
  args: {
    signalId: { type: "positional", description: "Signal id", required: true },
  },
  async run({ args }) {
    const result = await fetchSignalDetail(resolveConfig(), args.signalId);
    printResult(result);
  },
});

export const signalsCommand = defineCommand({
  meta: { name: "signals", description: "Read signals (spec 9.2)." },
  subCommands: { list, get },
});
