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
      args[key] = argv[i + 1];
      i++;
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

  await d1Execute(
    `INSERT INTO companies (id, slug, display_name, domain, industry, employee_band, created_at, updated_at)
     VALUES (${sqlString(id)}, ${sqlString(args.slug)}, ${sqlString(args.displayName)},
             ${sqlString(args.domain)}, ${sqlString(args.industry)}, ${sqlString(args.employeeBand)},
             ${sqlString(now)}, ${sqlString(now)})`,
    { local },
  );

  console.log(
    `Created company ${id} (slug="${args.slug}", displayName="${args.displayName}"). ` +
      `Use this id with add-source.mjs --company-id ${id} to attach its first ATS source.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
