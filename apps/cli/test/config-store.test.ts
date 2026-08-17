import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  loadSavedFilters,
  saveFilters,
  clearSavedFilters,
  hasAnyFilter,
  loadLastCheckedAt,
  recordLastCheckedAt,
  loadWatchedCompanies,
  watchCompany,
  unwatchCompany,
} from "../src/config-store";

/**
 * N.1 (ROADMAP.md): real filesystem I/O against a temp directory per test
 * -- no mocking of fs, since this is plain local-file I/O (not a
 * Cloudflare resource), same category AGENTS.md's zero-mocks policy
 * already excludes ("fixture inputs... still fine to construct"). Each
 * test gets HS_CONFIG_DIR pointed at a fresh mkdtemp() dir so tests never
 * touch a real home directory or collide with each other.
 */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hs-config-test-"));
  env = { HS_CONFIG_DIR: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("getConfigPath", () => {
  it("uses HS_CONFIG_DIR when set (test seam)", () => {
    expect(getConfigPath(env)).toBe(join(dir, "config.json"));
  });

  it("falls back to $XDG_CONFIG_HOME/hiring-signals/config.json when set and HS_CONFIG_DIR is not", () => {
    const path = getConfigPath({ XDG_CONFIG_HOME: "/xdg" });
    expect(path).toBe(join("/xdg", "hiring-signals", "config.json"));
  });

  it("falls back to ~/.hiring-signals/config.json when neither is set", () => {
    const path = getConfigPath({});
    expect(path.endsWith(join(".hiring-signals", "config.json"))).toBe(true);
  });
});

describe("saveFilters / loadSavedFilters round trip", () => {
  it("returns null when nothing has been saved yet", async () => {
    expect(await loadSavedFilters(env)).toBeNull();
  });

  it("saves raw flag strings and loads them back unchanged", async () => {
    await saveFilters({ role: "cybersecurity", country: "us" }, env);
    const loaded = await loadSavedFilters(env);
    // country round-trips uppercased by signalsQuerySchema's own transform
    // at LOAD time (validation), but the value returned is the raw saved
    // object -- role is untouched (still lowercase "us"), confirming
    // defaults (sort/limit/etc.) were never baked in.
    expect(loaded).toEqual({ role: "cybersecurity", country: "us" });
  });

  it("does not persist parsed defaults (sort/limit/minScore) into the saved file", async () => {
    await saveFilters({ role: "cybersecurity" }, env);
    const raw = JSON.parse(await readFile(getConfigPath(env), "utf8"));
    expect(raw.savedFilters).toEqual({ role: "cybersecurity" });
    expect(raw.savedFilters.sort).toBeUndefined();
    expect(raw.savedFilters.limit).toBeUndefined();
  });

  it("overwrites a previous saved profile rather than merging", async () => {
    await saveFilters({ role: "cybersecurity", company: "acme" }, env);
    await saveFilters({ role: "ai_machine_learning" }, env);
    expect(await loadSavedFilters(env)).toEqual({ role: "ai_machine_learning" });
  });

  it("silently discards and returns null when the saved value fails signalsQuerySchema", async () => {
    await saveFilters({ minScore: "not-a-number" }, env);
    expect(await loadSavedFilters(env)).toBeNull();
  });

  it("silently discards and returns null when the config file contains invalid JSON", async () => {
    // saveFilters first to create the parent directory, then corrupt it.
    await saveFilters({ role: "backend" }, env);
    await writeFile(getConfigPath(env), "{ not valid json", "utf8");
    expect(await loadSavedFilters(env)).toBeNull();
  });
});

describe("clearSavedFilters", () => {
  it("removes an existing saved profile", async () => {
    await saveFilters({ role: "cybersecurity" }, env);
    await clearSavedFilters(env);
    expect(await loadSavedFilters(env)).toBeNull();
  });

  it("is a no-op, not an error, when nothing was saved", async () => {
    await expect(clearSavedFilters(env)).resolves.toBeUndefined();
  });

  it("deletes the file entirely once savedFilters was the only key", async () => {
    await saveFilters({ role: "cybersecurity" }, env);
    await clearSavedFilters(env);
    await expect(readFile(getConfigPath(env), "utf8")).rejects.toThrow();
  });
});

describe("hasAnyFilter", () => {
  it("is false for an empty object", () => {
    expect(hasAnyFilter({})).toBe(false);
  });

  it("is false when every field is undefined or empty string", () => {
    expect(hasAnyFilter({ role: undefined, company: "" })).toBe(false);
  });

  it("is true when at least one field has a real value", () => {
    expect(hasAnyFilter({ role: "backend" })).toBe(true);
  });
});

describe("loadLastCheckedAt / recordLastCheckedAt (feature request: incremental --observed-since default)", () => {
  it("returns null when nothing has been recorded yet", async () => {
    expect(await loadLastCheckedAt(env)).toBeNull();
  });

  it("records and reads back a timestamp", async () => {
    const ts = "2026-08-17T00:00:00.000Z";
    await recordLastCheckedAt(ts, env);
    expect(await loadLastCheckedAt(env)).toBe(ts);
  });

  it("overwrites a previous timestamp with a newer one", async () => {
    await recordLastCheckedAt("2026-08-01T00:00:00.000Z", env);
    await recordLastCheckedAt("2026-08-17T00:00:00.000Z", env);
    expect(await loadLastCheckedAt(env)).toBe("2026-08-17T00:00:00.000Z");
  });

  it("preserves an existing saved filter profile when recording a timestamp", async () => {
    await saveFilters({ role: "cybersecurity" }, env);
    await recordLastCheckedAt("2026-08-17T00:00:00.000Z", env);
    expect(await loadSavedFilters(env)).toEqual({ role: "cybersecurity" });
    expect(await loadLastCheckedAt(env)).toBe("2026-08-17T00:00:00.000Z");
  });

  it("returns null for a corrupt (non-date) stored value rather than throwing", async () => {
    await recordLastCheckedAt("2026-08-17T00:00:00.000Z", env);
    await writeFile(
      getConfigPath(env),
      JSON.stringify({ lastCheckedAt: "not-a-real-date" }),
      "utf8",
    );
    expect(await loadLastCheckedAt(env)).toBeNull();
  });
});

describe("watchCompany / unwatchCompany / loadWatchedCompanies (feature request: company watchlist)", () => {
  it("returns an empty list when nothing has been watched", async () => {
    expect(await loadWatchedCompanies(env)).toEqual([]);
  });

  it("adds a company slug to the watchlist", async () => {
    const result = await watchCompany("gitlab", env);
    expect(result).toEqual(["gitlab"]);
    expect(await loadWatchedCompanies(env)).toEqual(["gitlab"]);
  });

  it("appends additional slugs, preserving insertion order", async () => {
    await watchCompany("gitlab", env);
    await watchCompany("acme-fintech", env);
    expect(await loadWatchedCompanies(env)).toEqual(["gitlab", "acme-fintech"]);
  });

  it("is idempotent -- watching an already-watched slug does not duplicate it", async () => {
    await watchCompany("gitlab", env);
    await watchCompany("gitlab", env);
    expect(await loadWatchedCompanies(env)).toEqual(["gitlab"]);
  });

  it("removes a watched slug", async () => {
    await watchCompany("gitlab", env);
    await watchCompany("acme-fintech", env);
    const result = await unwatchCompany("gitlab", env);
    expect(result).toEqual(["acme-fintech"]);
    expect(await loadWatchedCompanies(env)).toEqual(["acme-fintech"]);
  });

  it("is a no-op, not an error, when unwatching a slug that was never watched", async () => {
    await watchCompany("gitlab", env);
    const result = await unwatchCompany("not-watched", env);
    expect(result).toEqual(["gitlab"]);
  });

  it("is a no-op, not an error, when unwatching with no watchlist file at all", async () => {
    await expect(unwatchCompany("gitlab", env)).resolves.toEqual([]);
  });

  it("preserves an existing saved filter profile and lastCheckedAt when watching a company", async () => {
    await saveFilters({ role: "cybersecurity" }, env);
    await recordLastCheckedAt("2026-08-17T00:00:00.000Z", env);
    await watchCompany("gitlab", env);
    expect(await loadSavedFilters(env)).toEqual({ role: "cybersecurity" });
    expect(await loadLastCheckedAt(env)).toBe("2026-08-17T00:00:00.000Z");
    expect(await loadWatchedCompanies(env)).toEqual(["gitlab"]);
  });
});
