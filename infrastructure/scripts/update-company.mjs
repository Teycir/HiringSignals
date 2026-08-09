#!/usr/bin/env node
// Ops script: update an existing company's industry/employee-band tags
// (ROADMAP.md Milestone P.1, spec §8.2). `companies.industry` and
// `companies.employee_band` have existed on the schema since add-company.mjs
// (Phase 0 scaffolding) but no ops script exposed updating them after
// creation -- P.1 closes that gap. Same "plain Node process shells out to
// `wrangler d1 execute --json`" pattern every other ops script in this
// directory uses (see lib/d1-exec.mjs's own header comment for why).
//
// Usage:
//   node infrastructure/scripts/update-company.mjs --id <company-id> \
//     [--industry fintech] [--employee-band 51-200] [--remote]

import { d1Execute, sqlString } from "./lib/d1-exec.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remote") {
      args.remote = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      // Same "flag immediately followed by another flag has no value"
      // handling as add-company.mjs's parseArgs -- avoids silently
      // consuming the next flag's token as this flag's value.
      if (next === undefined || next.startsWith("--")) {
        args[key] = undefined;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id) {
    console.error("Missing required argument: --id <company-id>");
    console.error(
      "Usage: node update-company.mjs --id <company-id> [--industry <tag>] [--employee-band <band>] [--remote]",
    );
    process.exitCode = 1;
    return;
  }

  const local = !args.remote;

  const rows = await d1Execute(`SELECT id, slug, display_name FROM companies WHERE id = ${sqlString(args.id)}`, {
    local,
  });
  if (rows.length === 0) {
    console.error(`No company found with id "${args.id}".`);
    process.exitCode = 1;
    return;
  }

  const sets = [];
  // Blank/whitespace-only is rejected, not silently coerced to NULL --
  // unlike add-company.mjs's create-time emptyToNull (where an omitted
  // flag and an explicit "" both mean "leave unset"), here the caller
  // asked to *set* the field, so a blank value is almost certainly a
  // mistake worth failing loudly on rather than quietly clearing the
  // column. Pass a real value or omit the flag entirely to leave it
  // untouched.
  if (args.industry !== undefined) {
    if (args.industry.trim() === "") {
      console.error("--industry cannot be blank/whitespace-only.");
      process.exitCode = 1;
      return;
    }
    sets.push(`industry = ${sqlString(args.industry)}`);
  }
  if (args.employeeBand !== undefined) {
    if (args.employeeBand.trim() === "") {
      console.error("--employee-band cannot be blank/whitespace-only.");
      process.exitCode = 1;
      return;
    }
    sets.push(`employee_band = ${sqlString(args.employeeBand)}`);
  }

  if (sets.length === 0) {
    console.error("Nothing to update -- pass --industry and/or --employee-band.");
    process.exitCode = 1;
    return;
  }

  sets.push(`updated_at = ${sqlString(new Date().toISOString())}`);

  await d1Execute(`UPDATE companies SET ${sets.join(", ")} WHERE id = ${sqlString(args.id)}`, { local });

  console.log(`Updated company ${args.id} (${rows[0].slug} / "${rows[0].display_name}"): ${sets.join(", ")}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
