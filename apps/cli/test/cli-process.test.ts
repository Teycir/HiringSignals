import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F.1.5 (ROADMAP.md): "exit-code and stderr-shape assertions for the
 * error path." Unlike api-client.test.ts (mocked fetch, in-process),
 * this suite actually spawns the real bin/hs.mjs -- the only way to
 * exercise the re-exec wrapper (node --import node-typescript-resolver)
 * and main.ts's printErrorAndExit together, matching how an agent would
 * actually invoke this CLI. Each case picks a failure that doesn't
 * depend on wrangler dev being up, so this suite has no live-server
 * dependency (the live end-to-end path was already covered by the
 * manual `hs facets` smoke test against a running local apps/api).
 */

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "hs.mjs");

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

describe("hs CLI error paths (real subprocess)", () => {
  it("exits non-zero with a single-JSON-object stderr error on local Zod validation failure", () => {
    const result = runCli(["signals", "list", "--role", "backend"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
    expect(String(parsed.error.message)).toContain("invalid_enum_value");
  });

  it("exits non-zero with NETWORK_ERROR/req_none when the API host is unreachable", () => {
    const result = runCli(["facets"], { HS_API_BASE_URL: "http://127.0.0.1:1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  it("exits non-zero with MISSING_ADMIN_SECRET when an admin command runs without HS_ADMIN_SECRET", () => {
    const result = runCli(["admin", "reconcile", "--yes"], { HS_ADMIN_SECRET: "" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("MISSING_ADMIN_SECRET");
  });

  it("exits non-zero locally (no network call) when an admin command omits --yes", () => {
    const result = runCli(["admin", "reconcile"], { HS_ADMIN_SECRET: "s3cr3t" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error).toBeDefined();
  });

  it("prints exactly one line to stderr and nothing else mixed in (agent-parseable contract)", () => {
    const result = runCli(["signals", "list", "--role", "backend"]);

    const lines = result.stderr.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });
});
