import { defineCommand, runCommand } from "citty";
import { signalsCommand } from "./commands/signals";
import { companiesCommand } from "./commands/companies";
import { jobsCommand } from "./commands/jobs";
import { facetsCommand } from "./commands/facets";
import { sourcesCommand } from "./commands/sources";
import { exportCommand } from "./commands/export";
import { adminCommand } from "./commands/admin";
import { feedUrlCommand } from "./commands/feed-url";
import { trendsCommand } from "./commands/trends";
import { ApiClientError } from "./api-client";
import { setOutputFormat, type OutputFormat } from "./output";
import packageJson from "../package.json" with { type: "json" };

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
    version: packageJson.version,
    description: "HiringSignals CLI -- thin client over apps/api, JSON by default.",
  },
  subCommands: {
    signals: signalsCommand,
    companies: companiesCommand,
    jobs: jobsCommand,
    facets: facetsCommand,
    sources: sourcesCommand,
    export: exportCommand,
    admin: adminCommand,
    "feed-url": feedUrlCommand,
    trends: trendsCommand,
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

/**
 * `--format json|table` (spec §16.2) is parsed here, out of raw argv,
 * rather than declared in every leaf command's citty `args` block --
 * citty subcommands don't inherit a parent's args automatically, and
 * hand-declaring the same flag in 8+ files risks silently missing one
 * (exactly how F.1.1 lost this flag the first time, per that
 * milestone's own scope note). Stripped out of the array passed to
 * citty afterwards so it never reaches an individual command's `args`
 * parser or shows up as an "unknown flag" in --help text. Accepts
 * `--format=table` and `--format table` (two argv tokens) both, since
 * citty's own flags support both forms and a human typing this by hand
 * (the exact audience this flag is for) will use either interchangeably.
 * An unrecognized value falls back to "json" (the safe, existing
 * default) rather than throwing -- this flag is additive per output.ts's
 * own header comment, so it should never be the reason an otherwise-
 * valid command fails.
 */
function extractFormatFlag(argv: string[]): { format: OutputFormat; rest: string[] } {
  const rest: string[] = [];
  let format: OutputFormat = "json";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value === "table") format = "table";
      i++;
      continue;
    }
    if (arg?.startsWith("--format=")) {
      if (arg.slice("--format=".length) === "table") format = "table";
      continue;
    }
    rest.push(arg as string);
  }
  return { format, rest };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `--version`/`-v` handled here rather than left to citty's builtin
  // support, since that only fires inside runMain() (see header comment
  // above for why this file uses runCommand() instead) -- runCommand()
  // never checks these flags on its own. Only recognized as the sole
  // argument (matching citty's own runMain behavior) so it doesn't
  // shadow a subcommand's own use of -v/--version-like flags.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(packageJson.version + "\n");
    return;
  }
  const { format, rest } = extractFormatFlag(argv);
  setOutputFormat(format);
  try {
    await runCommand(rootCommand, { rawArgs: rest });
  } catch (err) {
    printErrorAndExit(err);
  }
}

void main();
