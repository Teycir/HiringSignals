import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Real subprocess tests for `hs companies watch`/`unwatch`/`list
 * --watched` (feature request, spec P1 "Company watchlists"). Same
 * spawnSync(bin/hs.mjs) + unreachable-API-host pattern
 * signals-list-saved-filters.test.ts already establishes: `watch`/
 * `unwatch` never call the API at all (pure local config-store.ts
 * state), so those assert success directly; `list --watched` DOES call
 * the API once per watched slug (fetchCompanyDetail), so it's asserted
 * against the unreachable-host NETWORK_ERROR path, same as every other
 * network-touching case in this file's sibling.
 */

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "hs.mjs");
const UNREACHABLE = "http://127.0.0.1:1";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "hs-cli-watchlist-"));
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

describe("hs companies watch <slug>", () => {
  it("adds the slug to the local watchlist and prints a JSON success object, no network call", () => {
    const result = runCli(["companies", "watch", "gitlab"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { watched: "gitlab", watchedCompanies: ["gitlab"] },
    });
  });

  it("persists the slug to config.json under watchedCompanies", async () => {
    runCli(["companies", "watch", "gitlab"]);
    const raw = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    expect(raw.watchedCompanies).toEqual(["gitlab"]);
  });

  it("is idempotent -- watching the same slug twice does not duplicate it", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["companies", "watch", "gitlab"]);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { watched: "gitlab", watchedCompanies: ["gitlab"] },
    });
  });

  it("accumulates multiple distinct slugs", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["companies", "watch", "acme-fintech"]);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { watched: "acme-fintech", watchedCompanies: ["gitlab", "acme-fintech"] },
    });
  });
});

describe("hs companies unwatch <slug>", () => {
  it("removes a watched slug and prints a JSON success object, no network call", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["companies", "unwatch", "gitlab"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { unwatched: "gitlab", watchedCompanies: [] },
    });
  });

  it("is a no-op success when the slug was never watched", () => {
    const result = runCli(["companies", "unwatch", "never-watched"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { unwatched: "never-watched", watchedCompanies: [] },
    });
  });
});

describe("hs companies list --watched", () => {
  it("calls the API once per watched slug and fails with NETWORK_ERROR against an unreachable host", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["companies", "list", "--watched"]);
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("NETWORK_ERROR");
  });

  it("makes no API call and succeeds trivially when the watchlist is empty", () => {
    const result = runCli(["companies", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.data).toEqual([]);
  });
});
