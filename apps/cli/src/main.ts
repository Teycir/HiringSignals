import { defineCommand, runCommand } from "citty";
import { signalsCommand } from "./commands/signals";
import { companiesCommand } from "./commands/companies";
import { facetsCommand } from "./commands/facets";
import { sourcesCommand } from "./commands/sources";
import { exportCommand } from "./commands/export";
import { adminCommand } from "./commands/admin";
import { feedUrlCommand } from "./commands/feed-url";
import { ApiClientError } from "./api-client";

/**
 * apps/cli entrypoint (ROADMAP.md Milestone F.1.1). Structured output by
 * default (F.1 design principle 1): every leaf command prints exactly one
 * JSON value to stdout and nothing else, so `hs ... | jq .` always works.
 *
 * Deliberately uses citty's runCommand(), not runMain(): runMain() catches
 * errors internally via consola and calls process.exit(1) itself, which
 * would print citty's own human-readable error format to stderr instead
 * of the single-JSON-object-on-stderr contract F.1 design principle 2
 * requires. runCommand() returns { result } and lets errors propagate to
 * the try/catch below, so this file owns the entire error-to-stderr
 * translation instead of citty's default (source: citty README/AGENTS.md
 * -- "Use runCommand over runMain for programmatic invocation").
 */
const rootCommand = defineCommand({
  meta: {
    name: "hs",
    version: "0.0.0",
    description: "HiringSignals CLI -- thin client over apps/api, JSON by default.",
  },
  subCommands: {
    signals: signalsCommand,
    companies: companiesCommand,
    facets: facetsCommand,
    sources: sourcesCommand,
    export: exportCommand,
    admin: adminCommand,
    "feed-url": feedUrlCommand,
  },
});

function printErrorAndExit(err: unknown): never {
  if (err instanceof ApiClientError) {
    process.stderr.write(
      JSON.stringify({ error: { code: err.code, message: err.message, requestId: err.requestId } }) + "\n",
    );
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(JSON.stringify({ error: { code: "CLI_ERROR", message, requestId: "req_none" } }) + "\n");
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    await runCommand(rootCommand, { rawArgs: process.argv.slice(2) });
  } catch (err) {
    printErrorAndExit(err);
  }
}

void main();
