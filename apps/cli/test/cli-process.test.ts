import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

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

  // Regression coverage for a bug found while auditing trends.ts's fix:
  // signalsQuerySchema.roles is (correctly) .optional() -- omitting
  // --role entirely means "no role filter," a legitimate query -- but
  // the piped array had no .min(1), so a *provided* value that reduces
  // to nothing after split/trim/filter(Boolean) (a bare comma, or an
  // empty string) silently parsed as roles=[], which listSignals'
  // buildCommonFilters (`params.roles?.length`) treats identically to
  // "no filter given." A caller who typed --role by mistake got every
  // role back with no error explaining why. Fixed by adding .min(1) to
  // the piped array (same as trends-query.ts's required `roles` field),
  // which rejects an empty *string* value while an *omitted* key still
  // short-circuits past validation via .optional(). This exercises
  // `signals list`; `export signals` and `feed-url` share the exact
  // same schema instance so aren't re-tested here.
  it("signals list exits non-zero locally (CLI_ERROR) when --role is a bare comma (empty after split)", () => {
    const result = runCli(["signals", "list", "--role", ","], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
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

  it("companies timeline exits non-zero with NETWORK_ERROR/req_none when the API host is unreachable", () => {
    // ROADMAP.md Milestone O.2: same NETWORK_ERROR-path assertion as the
    // `facets` case above, extended to the new `companies timeline`
    // subcommand -- confirms it goes through the same api-client.ts
    // request() error path (single JSON object on stderr, non-zero
    // exit), not a special-cased success-shape assumption.
    const result = runCli(["companies", "timeline", "acme"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  it("trends hiring exits non-zero with NETWORK_ERROR/req_none when the API host is unreachable", () => {
    // ROADMAP.md Milestone P.3: same NETWORK_ERROR-path assertion as the
    // `companies timeline` case above, extended to the new `trends
    // hiring` subcommand -- confirms it goes through the same
    // api-client.ts request() error path, not a special-cased
    // success-shape assumption.
    const result = runCli(["trends", "hiring", "--role", "ai_machine_learning"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  // Regression coverage for the bug fixed by routing trends.ts's run()
  // through trendsQuerySchema.parse() (previously it hand-split
  // args.role client-side and skipped validation entirely -- see
  // trends.ts's docstring). The first two cases mirror the "signals
  // list --role backend" CLI_ERROR/invalid_enum_value case above: they
  // must fail LOCALLY (no network call), matching the same contract
  // every sibling command already documents. HS_API_BASE_URL is
  // deliberately set to an unreachable host in each case -- if either
  // of these ever regresses back to a NETWORK_ERROR instead of
  // CLI_ERROR, that proves the bad value silently round-tripped to the
  // network again. The third case (trailing comma) is the inverse
  // check: it confirms the empty segment gets filtered out rather than
  // erroring OR leaking through as a literal empty value.
  it("trends hiring exits non-zero locally (CLI_ERROR/invalid_enum_value) on an invalid --role value", () => {
    const result = runCli(["trends", "hiring", "--role", "not_a_real_role"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
    expect(String(parsed.error.message)).toContain("invalid_enum_value");
  });

  it("trends hiring exits non-zero locally (CLI_ERROR) when --role is omitted entirely", () => {
    const result = runCli(["trends", "hiring"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("CLI_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  it("trends hiring treats a trailing-comma empty role segment as filtered-out, not an error", () => {
    // NOT a bug: trendsQuerySchema's .filter(Boolean) step (matching
    // signals-query.ts's identical transform) already drops the empty
    // "" segment produced by a trailing comma, leaving a valid single-
    // role array (["ai_machine_learning"]) that passes .min(1). So this
    // still reaches the network -- NETWORK_ERROR here is the CORRECT
    // outcome, confirming the empty segment never leaks into the
    // querystring as a literal empty role value (the actual bug
    // scenario was the OLD hand-rolled split that skipped this filter
    // entirely).
    const result = runCli(["trends", "hiring", "--role", "ai_machine_learning,"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  // spec §16.2 --format table (ROADMAP.md G.5 16.2 closure): these two
  // cases don't need a live server -- they confirm --format is stripped
  // out of argv before citty ever parses it (so it can't surface as an
  // "unknown flag" and break the existing error path) rather than
  // testing the table renderer's actual output, which needs a real
  // response body -- see cli-process-format.test.ts for that, run
  // against a live `wrangler dev` instance.
  it("--format table is stripped before citty parsing and doesn't change the NETWORK_ERROR error path", () => {
    const result = runCli(["facets", "--format", "table"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });

  it("--format=table (equals form) is also stripped and doesn't change the error path", () => {
    const result = runCli(["facets", "--format=table"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error.code).toBe("NETWORK_ERROR");
    expect(parsed.error.requestId).toBe("req_none");
  });
});

describe("hs --version / -v", () => {
  // main.ts hand-rolls this rather than relying on citty's builtin
  // --version handling: this file uses runCommand(), not runMain(),
  // for the JSON-error-shape contract every other test in this suite
  // exercises (see main.ts's header comment) -- but only runMain()
  // wires up citty's own --version/-v flags. Asserts against the live
  // apps/cli/package.json value rather than a hardcoded string so this
  // test can't silently pass against a stale version the way the old
  // hardcoded meta.version: "0.0.0" did.
  it("--version prints the real package.json version to stdout, exit 0, no stderr", () => {
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("-v prints the same version as --version", () => {
    const result = runCli(["-v"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("does not treat -v as the version flag when other arguments are present", () => {
    // Matches citty's own runMain semantics (only fires when it's the
    // SOLE argument) -- confirms `hs signals list -v` isn't silently
    // swallowed into a version print instead of reaching signals list's
    // own arg parsing.
    const result = runCli(["signals", "list", "-v"], {
      HS_API_BASE_URL: "http://127.0.0.1:1",
    });

    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.error).toBeDefined();
  });
});
