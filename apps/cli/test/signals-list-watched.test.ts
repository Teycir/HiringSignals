import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Real subprocess tests for `hs signals list --watched` (feature
 * request, complements the company watchlist config-store.ts already
 * provides for `hs companies list --watched` -- same
 * mkdtemp(HS_CONFIG_DIR)/spawnSync(bin/hs.mjs) pattern as
 * companies-watchlist.test.ts).
 *
 * `signals list --watched` fans out one GET /api/v1/signals request per
 * watched slug (fetchWatchedSignals in commands/signals.ts), unlike
 * `companies list --watched`'s fetchCompanyDetail fan-out -- but the
 * isolation contract is identical: Promise.allSettled means one bad
 * slug's failure lands in meta.failures, never the top-level
 * NETWORK_ERROR path every other case in cli-process.test.ts exercises.
 */

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "hs.mjs");
const UNREACHABLE = "http://127.0.0.1:1";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "hs-cli-signals-watched-"));
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

describe("hs signals list --watched", () => {
  it("makes no API call and succeeds trivially when the watchlist is empty", () => {
    const result = runCli(["signals", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.data).toEqual([]);
    expect(parsed.meta.failures).toEqual([]);
    expect(parsed.meta.nextCursor).toBeNull();
  });

  it("calls the API once per watched slug and isolates a NETWORK_ERROR to meta.failures instead of failing the whole command", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["signals", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.data).toEqual([]);
    expect(parsed.meta.failures).toEqual([
      expect.objectContaining({ slug: "gitlab", code: "NETWORK_ERROR" }),
    ]);
  });

  it("isolates failures per slug across multiple watched companies", () => {
    runCli(["companies", "watch", "gitlab"]);
    runCli(["companies", "watch", "acme-fintech"]);
    const result = runCli(["signals", "list", "--watched"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.meta.failures).toHaveLength(2);
    expect(parsed.meta.failures.map((f: { slug: string }) => f.slug).sort()).toEqual([
      "acme-fintech",
      "gitlab",
    ]);
  });

  it("--watched overrides --company rather than combining with it", () => {
    // No network-observable way to prove --company was dropped against
    // an unreachable host (both scenarios fail the same way), but this
    // locks in that appliedFilters never carries a `company` key
    // through --watched's fetchWatchedSignals path -- if --company
    // leaked through, this would be `{ ..., company: "stripe", ... }`
    // instead.
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["signals", "list", "--watched", "--company", "stripe"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.meta.appliedFilters).not.toHaveProperty("company");
    expect(parsed.meta.appliedFilters.watched).toBe(true);
    expect(parsed.meta.failures).toEqual([
      expect.objectContaining({ slug: "gitlab", code: "NETWORK_ERROR" }),
    ]);
  });

  it("silently ignores --cursor rather than erroring", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["signals", "list", "--watched", "--cursor", "some-opaque-cursor"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.meta.appliedFilters).not.toHaveProperty("cursor");
    expect(parsed.meta.nextCursor).toBeNull();
  });

  it("--format table renders the merged result without a cursor note", () => {
    runCli(["companies", "watch", "gitlab"]);
    const result = runCli(["--format", "table", "signals", "list", "--watched"]);
    expect(result.status).toBe(0);
    // Empty data set under an unreachable host -- table renderer should
    // still produce clean output (header row only, or an empty-table
    // message), never crash, and never print the cursor-pagination hint
    // since nextCursor is always null for --watched.
    expect(result.stdout).not.toContain("--cursor");
  });

  it("--watched is not persisted by --save (data-source selector, not a filter value)", async () => {
    // Same precedence companies.ts's list --watched establishes for
    // --q: --watched decides WHERE to look, not what to filter for, so
    // it has no business inside the saved filter profile. Asserted
    // indirectly: running --save with --watched must not error, and a
    // subsequent bare `signals list` (no flags) must NOT silently
    // re-apply --watched from a saved profile that was never supposed
    // to store it -- it goes through the real (non-watched) fetch path
    // instead, which fails with a top-level NETWORK_ERROR against the
    // unreachable host, same as every other saved-profile case in
    // signals-list-saved-filters.test.ts. Auto-apply also prints a
    // one-line "Using saved filters: ..." note to stderr BEFORE the
    // JSON error line (signals.ts's own documented behavior) -- so the
    // JSON error is asserted from the last stderr line, not the whole
    // trimmed stream.
    runCli(["companies", "watch", "gitlab"]);
    runCli(["signals", "list", "--watched", "--role", "software_engineering", "--save"]);
    const result = runCli(["signals", "list"]);
    expect(result.status).not.toBe(0);
    const lines = result.stderr.trim().split("\n");
    const err = JSON.parse(lines[lines.length - 1] as string);
    expect(err.error.code).toBe("NETWORK_ERROR");
  });
});
