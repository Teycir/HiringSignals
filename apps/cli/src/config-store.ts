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
  /** ISO-8601 timestamp of the last successful `hs signals list` call
   * that used the saved filter profile (feature request: default
   * `--observed-since` to "since my last check" for the saved profile,
   * so a passive/scripted agent gets an incremental "what's new" feed
   * without having to track its own last-run timestamp). Updated after
   * every successful saved-profile-backed `signals list` call, not on
   * every invocation with arbitrary flags -- this is specifically "when
   * did I last check my usual search," not a generic request log. */
  lastCheckedAt?: string;
  /** Company slugs the user has flagged as worth tracking (feature
   * request: company watchlist, spec P1 "Company watchlists"). No
   * server-side concept of "watched" exists -- this is purely local
   * config, same storage tier as savedFilters -- so `hs companies
   * list --watched` resolves each slug via a live `companies get` call
   * rather than a filtered list query. Order is insertion order; no
   * dedup guarantee is needed beyond what watchCompany() already
   * enforces (see below). */
  watchedCompanies?: string[];
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

/**
 * Reads the saved profile's `lastCheckedAt` (or null if never set / no
 * profile exists). Deliberately does NOT validate against
 * signalsQuerySchema the way loadSavedFilters does -- this is a plain
 * ISO-8601 string with no schema-level defaults to worry about baking
 * in, so a minimal own-format check (parses as a valid Date) is enough.
 * Returns null rather than throwing on a corrupt/missing value, same
 * "just proceed unfiltered" fallback as the rest of this file.
 */
export async function loadLastCheckedAt(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const file = await readConfigFile(getConfigPath(env));
  const value = file?.lastCheckedAt;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

/**
 * Records `timestamp` as the saved profile's `lastCheckedAt`, preserving
 * every other config key untouched. Called after a successful
 * saved-profile-backed `hs signals list` run so the *next* invocation
 * with no flags can default `observedSince` to "since that run" --
 * turning the CLI into an incremental "what's new" feed for an
 * unattended/scripted agent without it having to track its own
 * last-run state (feature request, complements ROADMAP.md N.1's saved
 * filters). Silently a no-op on write failure, matching this file's
 * existing best-effort persistence posture elsewhere (saveFilters
 * itself does propagate errors, but lastCheckedAt is a courtesy
 * convenience value, not user-authored data -- losing one update here
 * just means the next `--observed-since` default is slightly stale,
 * never wrong in a way that drops real signals).
 */
export async function recordLastCheckedAt(
  timestamp: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = getConfigPath(env);
  try {
    await mkdir(dirname(path), { recursive: true });
    const existing = (await readConfigFile(path)) ?? {};
    const next: ConfigFileShape = { ...existing, lastCheckedAt: timestamp };
    await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort only -- see docstring.
  }
}

/**
 * Company watchlist (spec P1 "Company watchlists"). Slugs only, no
 * duplicate entries (`watchCompany` is idempotent -- watching an already
 * -watched slug is a no-op, not an error, matching this CLI's existing
 * "repeat operations are safe" posture elsewhere, e.g. clearSavedFilters
 * on an empty file).
 */
export async function loadWatchedCompanies(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const file = await readConfigFile(getConfigPath(env));
  const list = file?.watchedCompanies;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Adds `slug` to the watchlist if not already present. Returns the
 * full updated list. */
export async function watchCompany(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const path = getConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  const existing = (await readConfigFile(path)) ?? {};
  const current = Array.isArray(existing.watchedCompanies) ? existing.watchedCompanies : [];
  const next = current.includes(slug) ? current : [...current, slug];
  const nextFile: ConfigFileShape = { ...existing, watchedCompanies: next };
  await writeFile(path, JSON.stringify(nextFile, null, 2) + "\n", "utf8");
  return next;
}

/** Removes `slug` from the watchlist, if present. Returns the full
 * updated list. No-op, not an error, if the slug wasn't watched or no
 * watchlist exists yet. */
export async function unwatchCompany(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const path = getConfigPath(env);
  const existing = await readConfigFile(path);
  if (!existing || !Array.isArray(existing.watchedCompanies)) return [];
  const next = existing.watchedCompanies.filter((s) => s !== slug);
  const nextFile: ConfigFileShape = { ...existing, watchedCompanies: next };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(nextFile, null, 2) + "\n", "utf8");
  return next;
}
