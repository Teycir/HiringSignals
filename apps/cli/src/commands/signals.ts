import { defineCommand } from "citty";
import { signalsQuerySchema } from "@hiring-signals/domain";
import { fetchSignals, fetchSignalDetail, resolveConfig } from "../api-client";
import {
  loadSavedFilters,
  saveFilters,
  clearSavedFilters,
  hasAnyFilter,
  type SavedFilterFlags,
} from "../config-store";

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
      process.stdout.write(JSON.stringify({ data: { clearedSaved: true } }) + "\n");
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
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

/** `hs signals get <signalId>` -- GET /api/v1/signals/:signalId (spec 10.5). */
const get = defineCommand({
  meta: { name: "get", description: "Get a single signal by id, with evidence." },
  args: {
    signalId: { type: "positional", description: "Signal id", required: true },
  },
  async run({ args }) {
    const result = await fetchSignalDetail(resolveConfig(), args.signalId);
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

export const signalsCommand = defineCommand({
  meta: { name: "signals", description: "Read signals (spec 9.2)." },
  subCommands: { list, get },
});
