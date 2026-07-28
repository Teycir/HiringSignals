#!/usr/bin/env node
// Ops script: register a new company (ROADMAP.md open item found while
// building the source-management scripts; spec §13.5 -- company/source
// management are both write-path config, never an HTTP route).
//
// Usage:
//   node infrastructure/scripts/add-company.mjs \
//     --slug acme-inc --display-name "Acme Inc" \
//     [--domain acme.com] [--industry fintech] [--employee-band 51-200] [--remote]
//
// After creating a company, use add-source.mjs with the printed
// --company-id to attach its first ATS source.

import { d1Execute, sqlString } from "./lib/d1-exec.mjs";

// sqlString() already maps null/undefined to SQL NULL, but not "" -- an
// unset optional flag arrives here as undefined (parseArgs never sets
// the key), so in practice this mainly guards a caller passing an
// explicit empty string. Keeps "" and omitted consistently -> NULL,
// same normalization as companies-repo.ts's createCompany().
function emptyToNull(value) {
  return value === undefined || value === "" ? undefined : value;
}

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
      // A flag immediately followed by another flag (or by nothing) has
      // no value -- assigning `undefined` here (rather than silently
      // consuming the next flag's token as this flag's value) means the
      // required-argument check below reports it as missing instead of
      // corrupting two flags at once.
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

  const missing = ["slug", "displayName"].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.join(", ")}`);
    console.error('Usage: node add-company.mjs --slug <slug> --display-name "<Display Name>"');
    process.exitCode = 1;
    return;
  }

  // `--slug "  "` passes the truthiness check above (a non-empty string)
  // but would persist a blank/whitespace-only value -- reject explicitly
  // rather than let it through to a technically-valid-but-useless row.
  const blank = ["slug", "displayName"].filter((k) => args[k].trim() === "");
  if (blank.length > 0) {
    console.error(`Argument(s) cannot be blank/whitespace-only: ${blank.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const local = !args.remote;

  // Duplicate slug check -- mirrors companies-repo.ts's createCompany()
  // DuplicateCompanyError, reimplemented as a pre-check here since this
  // script can't import that function directly (see lib/d1-exec.mjs
  // header: no live D1Database binding outside a Worker).
  const existing = await d1Execute(`SELECT id FROM companies WHERE slug = ${sqlString(args.slug)}`, {
    local,
  });
  if (existing.length > 0) {
    console.error(`Company already exists with slug="${args.slug}" (id=${existing[0].id}).`);
    process.exitCode = 1;
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await d1Execute(
      `INSERT INTO companies (id, slug, display_name, domain, industry, employee_band, created_at, updated_at)
       VALUES (${sqlString(id)}, ${sqlString(args.slug)}, ${sqlString(args.displayName)},
               ${sqlString(emptyToNull(args.domain))}, ${sqlString(emptyToNull(args.industry))},
               ${sqlString(emptyToNull(args.employeeBand))}, ${sqlString(now)}, ${sqlString(now)})`,
      { local },
    );
  } catch (err) {
    // The SELECT pre-check above is a TOCTOU race, not a guarantee -- two
    // invocations racing on the same slug can both pass the check and
    // then one INSERT fails on the UNIQUE constraint. Catch that case
    // specifically and print the same clear message the pre-check gives,
    // instead of letting a raw D1 error reach main()'s generic catch.
    // Mirrors companies-repo.ts's createCompany() try/catch around its
    // own INSERT.
    if (/UNIQUE constraint failed/i.test(err.message)) {
      const dup = await d1Execute(`SELECT id FROM companies WHERE slug = ${sqlString(args.slug)}`, {
        local,
      });
      console.error(`Company already exists with slug="${args.slug}" (id=${dup[0]?.id ?? "unknown"}).`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(
    `Created company ${id} (slug="${args.slug}", displayName="${args.displayName}"). ` +
      `Use this id with add-source.mjs --company-id ${id} to attach its first ATS source.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
