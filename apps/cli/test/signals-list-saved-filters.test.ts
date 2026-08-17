import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * N.1 (ROADMAP.md): real subprocess tests for `hs signals list
 * --save`/`--clear-saved`/auto-apply, same spawnSync(bin/hs.mjs) pattern
 * cli-process.test.ts already uses -- the only way to exercise main.ts's
 * argv parsing + config-store.ts's real filesystem I/O together, the way
 * an agent would actually invoke this CLI. HS_API_BASE_URL is pointed at
 * an unreachable host (127.0.0.1:1, same trick cli-process.test.ts uses)
 * so every case fails at the final fetchSignals call with NETWORK_ERROR
 * -- that failure happens strictly *after* the save/load/clear logic
 * this file is actually testing, so a NETWORK_ERROR exit is the expected,
 * asserted outcome here, not a test bug.
 */

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "hs.mjs");
const UNREACHABLE = "http://127.0.0.1:1";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "hs-cli-saved-filters-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HS_API_BASE_URL: UNREACHABLE, HS_CONFIG_DIR: configDir, ...extraEnv },
    timeout: 15_000,
  });
}

describe("hs signals list --save", () => {
  it("persists the given filter flags to the config file, then proceeds to call the API", () => {
    const result = runCli(["signals", "list", "--role", "cybersecurity", "--save"]);

    // Still fails (unreachable API), but only after saving -- confirms
    // --save doesn't short-circuit the normal list flow.
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("NETWORK_ERROR");
  });

  it("writes the exact flag value to config.json under savedFilters", async () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--company", "acme", "--save"]);
    const raw = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    expect(raw.savedFilters).toEqual({ role: "cybersecurity", company: "acme" });
  });
});

describe("hs signals list --clear-saved", () => {
  it("removes the saved profile and prints a JSON success object without calling the API", () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const result = runCli(["signals", "list", "--clear-saved"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ data: { clearedSaved: true } });
  });

  it("is a no-op success when nothing was saved", () => {
    const result = runCli(["signals", "list", "--clear-saved"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ data: { clearedSaved: true } });
  });
});

describe("hs signals list with no flags and a saved profile", () => {
  it("auto-applies the saved profile and prints a one-line stderr note before failing on the network call", () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--country", "US", "--save"]);
    const result = runCli(["signals", "list"]);

    expect(result.status).not.toBe(0);
    const lines = result.stderr.trim().split("\n");
    expect(lines[0]).toBe("Using saved filters: role=cybersecurity, country=US");
    // Final line is still the one-JSON-object error contract.
    const err = JSON.parse(lines[lines.length - 1] as string);
    expect(err.error.code).toBe("NETWORK_ERROR");
  });

  it("does not auto-apply, and prints no saved-filters note, when the user supplies any flag", () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const result = runCli(["signals", "list", "--company", "other-co"]);

    expect(result.stderr).not.toContain("Using saved filters");
  });

  it("proceeds unfiltered (no note, still a network failure) when no profile was ever saved", () => {
    const result = runCli(["signals", "list"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("Using saved filters");
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("NETWORK_ERROR");
  });
});

/**
 * Feature request: default --observed-since to "since my last check" for
 * the saved profile (config-store.ts's lastCheckedAt). Same
 * unreachable-host-so-it-fails-after-the-real-logic-under-test pattern as
 * the rest of this file -- lastCheckedAt is only ever written AFTER a
 * successful fetchSignals call, so these tests seed it directly via a
 * plain fs write (the loadLastCheckedAt/recordLastCheckedAt round trip
 * itself is covered in config-store.test.ts) rather than needing a real
 * API response.
 */
describe("hs signals list -- incremental default from lastCheckedAt", () => {
  it("prints a stderr note and applies lastCheckedAt as observedSince when the saved profile has no explicit --observed-since", async () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const { writeFile, readFile } = await import("node:fs/promises");
    const configPath = join(configDir, "config.json");
    const existing = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, lastCheckedAt: "2026-08-01T00:00:00.000Z" }),
      "utf8",
    );

    const result = runCli(["signals", "list"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Showing signals observed since last check: 2026-08-01T00:00:00.000Z",
    );
  });

  it("does not apply the lastCheckedAt default when --observed-since is given explicitly", async () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const { writeFile, readFile } = await import("node:fs/promises");
    const configPath = join(configDir, "config.json");
    const existing = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, lastCheckedAt: "2026-08-01T00:00:00.000Z" }),
      "utf8",
    );

    const result = runCli(["signals", "list", "--observed-since", "2026-08-10T00:00:00Z"]);
    expect(result.stderr).not.toContain("Showing signals observed since last check");
  });

  it("does not apply the lastCheckedAt default for an ad hoc query with explicit filter flags", async () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const { writeFile, readFile } = await import("node:fs/promises");
    const configPath = join(configDir, "config.json");
    const existing = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, lastCheckedAt: "2026-08-01T00:00:00.000Z" }),
      "utf8",
    );

    const result = runCli(["signals", "list", "--company", "other-co"]);
    expect(result.stderr).not.toContain("Showing signals observed since last check");
  });

  it("does nothing extra when no lastCheckedAt has ever been recorded", () => {
    runCli(["signals", "list", "--role", "cybersecurity", "--save"]);
    const result = runCli(["signals", "list"]);
    expect(result.stderr).not.toContain("Showing signals observed since last check");
  });
});

/**
 * Feature request: `--watch <seconds>` polling mode. Only the local
 * validation path is exercised here (a real watch loop calling an
 * unreachable host would fail its first fetch before ever reaching the
 * setTimeout, but asserting on an intentionally-never-ending loop isn't
 * a good subprocess-test shape) -- the argument-validation branch runs
 * and throws synchronously before any network call, so it's a clean,
 * fast, deterministic case to assert on with this same harness.
 */
describe("hs signals list --watch validation", () => {
  it("rejects a non-numeric --watch value with a local CLI_ERROR, no network call", () => {
    const result = runCli(["signals", "list", "--watch", "not-a-number"]);
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("CLI_ERROR");
    expect(err.error.message).toContain("--watch must be a positive number of seconds");
  });

  it("rejects a zero or negative --watch value with a local CLI_ERROR, no network call", () => {
    const result = runCli(["signals", "list", "--watch", "0"]);
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("CLI_ERROR");
  });
});
