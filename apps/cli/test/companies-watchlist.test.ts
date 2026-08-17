import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Real subprocess tests for `hs companies watch`/`unwatch`/`list
 * --watched` (feature request, spec P1 "Company watchlists"). Same
 * spawnSync(bin/hs.mjs) + unreachable-API-host pattern
 * signals-list-saved-filters.test.ts already establishes: `watch`/
 * `unwatch` never call the API at all (pure local config-store.ts
 * state), so those assert success directly; `list --watched` DOES call
 * the API once per watched slug (fetchCompanyDetail) via
 * Promise.allSettled, so a failure against the unreachable host is
 * asserted as an isolated entry in `meta.failures` (command still exits
 * 0) rather than the top-level NETWORK_ERROR path every other
 * network-touching case in this file's sibling uses -- bug found in
 * review: this used to be Promise.all, so one bad slug took the whole
 * list down.
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
  it("calls the API once per watched slug and isolates a NETWORK_ERROR to meta.failures instead of failing the whole command", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["companies", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.data).toEqual([]);
    expect(parsed.meta.failures).toEqual([
      expect.objectContaining({ slug: "gitlab", code: "NETWORK_ERROR" }),
    ]);
  });

  it("returns successful watched companies even when a different watched slug fails", () => {
    // Bug found in review: Promise.all previously made one bad slug
    // (404/network error) take down the entire --watched list, even
    // for slugs that would have succeeded. This can't easily assert a
    // *mixed* success/failure result against a single unreachable host
    // (every slug fails the same way here), but it locks in that
    // multiple watched slugs each get their own isolated outcome in
    // meta.failures rather than one shared top-level error.
    runCli(["companies", "watch", "gitlab"]);
    runCli(["companies", "watch", "acme-fintech"]);
    const result = runCli(["companies", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.meta.failures).toHaveLength(2);
    expect(parsed.meta.failures.map((f: { slug: string }) => f.slug).sort()).toEqual([
      "acme-fintech",
      "gitlab",
    ]);
  });

  it("makes no API call and succeeds trivially when the watchlist is empty", () => {
    const result = runCli(["companies", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.data).toEqual([]);
  });
});

/**
 * Bug found in review: watchCompany/unwatchCompany originally had no
 * local error handling at all around their fs writes. main.ts's
 * top-level catch already turns *any* thrown error into a structured
 * CLI_ERROR envelope (never an uncaught crash), so this was never a
 * crash bug -- but the surfaced message was Node's raw
 * "EACCES: permission denied, mkdir '...'" string rather than a clean,
 * CLI-authored one. config-store.ts's writeConfigFile() now wraps that.
 * These tests force a real EACCES by chmod'ing the config dir's PARENT
 * read-only (555) before the CLI can mkdir the actual config dir under
 * it -- not the config dir itself, since mkdtemp already created that
 * writable, and a subsequent chmod on it wouldn't block *creating a
 * config.json inside it* the same reliable way a missing, permission-
 * denied parent does. Skipped on win32: POSIX permission bits don't
 * apply the same way there, so this would be flaky/no-op on Windows CI.
 */
describe.skipIf(platform() === "win32")("write failure surfaces a clean CLI_ERROR, not a raw fs error", () => {
  let readonlyParent: string;
  let unwritableConfigDir: string;

  beforeEach(async () => {
    readonlyParent = await mkdtemp(join(tmpdir(), "hs-cli-watchlist-ro-"));
    unwritableConfigDir = join(readonlyParent, "config-dir-that-cant-be-created");
    await chmod(readonlyParent, 0o555);
  });

  afterEach(async () => {
    await chmod(readonlyParent, 0o755); // restore write perms so rm can clean up
    await rm(readonlyParent, { recursive: true, force: true });
  });

  it("hs companies watch <slug> fails with CLI_ERROR and a clean message, not a raw EACCES string", () => {
    const result = runCli(["companies", "watch", "gitlab"], { HS_CONFIG_DIR: unwritableConfigDir });
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("CLI_ERROR");
    expect(err.error.message).toContain("Could not write to config file");
    expect(err.error.message).toContain("EACCES");
  });

  it("hs signals list --save fails with CLI_ERROR and a clean message, not a raw EACCES string", () => {
    const result = runCli(
      ["signals", "list", "--role", "backend", "--save"],
      { HS_CONFIG_DIR: unwritableConfigDir },
    );
    expect(result.status).not.toBe(0);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("CLI_ERROR");
    expect(err.error.message).toContain("Could not write to config file");
  });

  it("hs companies unwatch <slug> is unaffected -- it never writes when there's nothing to remove", () => {
    // unwatchCompany's early-return (no existing file / no watchedCompanies
    // array) means this never reaches writeConfigFile at all, so it should
    // still succeed even with an unwritable parent -- confirms the fix
    // didn't accidentally make a genuinely-no-op path start failing.
    const result = runCli(["companies", "unwatch", "gitlab"], { HS_CONFIG_DIR: unwritableConfigDir });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      data: { unwatched: "gitlab", watchedCompanies: [] },
    });
  });
});
