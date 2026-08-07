import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { signalsQuerySchema } from "@hiring-signals/domain";

/**
 * Local saved-filter-profile storage (ROADMAP.md Milestone N.1). CLI-native
 * equivalent of the deleted apps/web's localStorage "saved dashboard view"
 * (spec P1) -- a CLI is a Node process with no browser storage API, so a
 * local JSON config file is the closest analog: same "don't re-type
 * role/location every invocation" value, different storage mechanism.
 *
 * Stores RAW pre-parse flag strings (e.g. `{ role: "backend" }`), not
 * signalsQuerySchema's parsed/defaulted output. This matters:
 * signalsQuerySchema applies defaults on parse (sort="score_desc",
 * limit=50, minScore=0) and transforms roles from a comma string into a
 * string[] -- persisting that *output* would silently bake those defaults
 * into every saved profile even for fields the user never touched,
 * turning "reuse my saved role/location filters" into "always force
 * sort=score_desc" too. Storing the raw flags keeps a saved profile a
 * faithful record of exactly what the user typed, and re-parsing on load
 * still goes through the one real schema (same reasoning as every other
 * command in this CLI: one schema, not a second copy of validation).
 *
 * No v1 versioning (decided, ROADMAP.md N.1): if the stored JSON fails
 * signalsQuerySchema parsing on load, silently discard it and proceed
 * unfiltered -- a CLI has no persistent UI to show a re-save prompt
 * between invocations, so "just proceed" is the adapted fallback.
 */

/** Raw (pre-parse) shape of `hs signals list`'s filter flags -- the same
 * 9 fields signals.ts/export.ts/feed-url.ts already accept, kept here as
 * their own type rather than importing SignalsQuery, since this is the
 * *input* shape (comma string for roles, string minScore) not the parsed
 * output shape (string[] roles, coerced number minScore). */
export interface SavedFilterFlags {
  role?: string;
  company?: string;
  q?: string;
  locationMode?: string;
  country?: string;
  source?: string;
  signalType?: string;
  minScore?: string;
  observedSince?: string;
}

interface ConfigFileShape {
  savedFilters?: SavedFilterFlags;
}

/**
 * Resolves the config file path. ROADMAP.md N.1's own wording is
 * "`~/.hiring-signals/config.json` or `$XDG_CONFIG_HOME` equivalent" --
 * read literally, `~/.hiring-signals/config.json` is the primary path
 * (a dotfile directly under home, not nested under `~/.config`), with
 * `$XDG_CONFIG_HOME/hiring-signals/config.json` as the "equivalent" for
 * a system where that variable is set, following the same convention
 * most XDG-aware CLIs use for the choice between the two.
 * `HS_CONFIG_DIR` is a CLI-internal test seam (not part of the public
 * flag/env surface documented in apps/cli/README.md) so tests can point
 * this at a temp directory instead of a real home directory -- same
 * pattern resolveConfig() in api-client.ts already uses for
 * HS_API_BASE_URL/HS_ADMIN_SECRET.
 */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HS_CONFIG_DIR) return join(env.HS_CONFIG_DIR, "config.json");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "hiring-signals", "config.json");
  return join(homedir(), ".hiring-signals", "config.json");
}

async function readConfigFile(path: string): Promise<ConfigFileShape | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null; // No file yet -- not an error, just "nothing saved."
  }
  try {
    return JSON.parse(raw) as ConfigFileShape;
  } catch {
    return null; // Corrupt JSON -- discard silently per N.1's no-versioning decision.
  }
}

/**
 * Loads the saved filter profile, or null if none exists / the stored
 * value fails signalsQuerySchema validation (N.1's "no v1 versioning --
 * silently discard on parse failure" decision). Re-validates against the
 * real schema on every load rather than trusting the file blindly, since
 * the schema (and thus what's a valid saved value) can change between
 * CLI versions.
 */
export async function loadSavedFilters(env: NodeJS.ProcessEnv = process.env): Promise<SavedFilterFlags | null> {
  const file = await readConfigFile(getConfigPath(env));
  const saved = file?.savedFilters;
  if (!saved || typeof saved !== "object") return null;

  const filterSchema = signalsQuerySchema.omit({ sort: true, cursor: true, limit: true });
  const result = filterSchema.safeParse({
    roles: saved.role,
    company: saved.company,
    q: saved.q,
    locationMode: saved.locationMode,
    country: saved.country,
    source: saved.source,
    signalType: saved.signalType,
    minScore: saved.minScore,
    observedSince: saved.observedSince,
  });
  if (!result.success) return null;
  return saved;
}

/** Writes `flags` as the saved filter profile, creating the config
 * directory if needed. Overwrites any existing saved profile -- N.1
 * describes a single saved profile, not multiple named profiles. */
export async function saveFilters(flags: SavedFilterFlags, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = getConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  const existing = (await readConfigFile(path)) ?? {};
  const next: ConfigFileShape = { ...existing, savedFilters: flags };
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** Removes the saved filter profile (`hs signals list --clear-saved`).
 * No-op, not an error, if nothing was saved. */
export async function clearSavedFilters(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = getConfigPath(env);
  const existing = await readConfigFile(path);
  if (!existing) return;
  const { savedFilters: _removed, ...rest } = existing;
  if (Object.keys(rest).length === 0) {
    await rm(path, { force: true });
  } else {
    await writeFile(path, JSON.stringify(rest, null, 2) + "\n", "utf8");
  }
}

/** True if `flags` has at least one filter field set -- used by `hs
 * signals list` to decide whether the user supplied any filters at all
 * (in which case saved filters are never auto-applied, only used when
 * *no* flags were given, matching N.1's "no flags supplied" trigger). */
export function hasAnyFilter(flags: SavedFilterFlags): boolean {
  return Object.values(flags).some((v) => v !== undefined && v !== "");
}
