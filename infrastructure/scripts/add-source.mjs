#!/usr/bin/env node
// Ops script: register a new source (ROADMAP.md Milestone D, spec §13.5).
// Source management has no HTTP admin surface -- the app is public/free
// permanently, so this is a local script against D1, not a route.
//
// Usage:
//   node infrastructure/scripts/add-source.mjs \
//     --company-id <existing company id> \
//     --provider greenhouse \
//     --board-token acme \
//     --public-url https://boards.greenhouse.io/acme \
//     [--poll-interval-minutes 360] [--disabled] [--remote]
//
// Requires an EXISTING company_id. To create a brand-new company first,
// use infrastructure/scripts/add-company.mjs (ROADMAP.md open item,
// closed 2026-07-28) -- it prints the new company's id for direct use
// here as --company-id. To look up an id for an existing company:
// `wrangler d1 execute hiring-signals --local --command "SELECT id, slug,
// display_name FROM companies WHERE slug = '...'"`.

import { d1Execute, sqlString, sqlBool } from "./lib/d1-exec.mjs";

const ATS_PROVIDERS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "personio",
  "teamtailor",
  "jazzhr",
  "breezy",
  "bamboohr",
]; // must stay in sync with packages/domain/src/providers.ts's ATS_PROVIDERS

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--disabled") {
      args.disabled = true;
      continue;
    }
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

  const missing = ["companyId", "provider", "boardToken", "publicUrl"].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.join(", ")}`);
    console.error(
      "Usage: node add-source.mjs --company-id <id> --provider <provider> --board-token <token> --public-url <url>",
    );
    process.exitCode = 1;
    return;
  }

  if (!ATS_PROVIDERS.includes(args.provider)) {
    console.error(`Unknown provider "${args.provider}". Must be one of: ${ATS_PROVIDERS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const local = !args.remote;

  // Confirm the company exists first -- a clearer failure than the FK
  // constraint D1 would otherwise raise on INSERT.
  const company = await d1Execute(
    `SELECT id, display_name FROM companies WHERE id = ${sqlString(args.companyId)}`,
    { local },
  );
  if (company.length === 0) {
    console.error(`No company found with id "${args.companyId}". Create the company row first.`);
    process.exitCode = 1;
    return;
  }

  // Duplicate (provider, board_token) check -- mirrors sources-repo.ts's
  // createSource() DuplicateSourceError, reimplemented as a pre-check
  // here since this script can't import that function directly (see
  // lib/d1-exec.mjs header).
  const existing = await d1Execute(
    `SELECT id FROM sources WHERE provider = ${sqlString(args.provider)} AND board_token = ${sqlString(args.boardToken)}`,
    { local },
  );
  if (existing.length > 0) {
    console.error(
      `Source already exists for provider="${args.provider}" boardToken="${args.boardToken}" (id=${existing[0].id}).`,
    );
    process.exitCode = 1;
    return;
  }

  const id = crypto.randomUUID();
  const enabled = !args.disabled;
  const pollIntervalMinutes = args.pollIntervalMinutes ? Number(args.pollIntervalMinutes) : 360;

  await d1Execute(
    `INSERT INTO sources
       (id, company_id, provider, board_token, public_url, enabled,
        poll_interval_minutes, next_poll_at, last_success_at, consecutive_failures)
     VALUES (${sqlString(id)}, ${sqlString(args.companyId)}, ${sqlString(args.provider)},
             ${sqlString(args.boardToken)}, ${sqlString(args.publicUrl)}, ${sqlBool(enabled)},
             ${pollIntervalMinutes}, NULL, NULL, 0)`,
    { local },
  );

  console.log(
    `Created source ${id} for ${company[0].display_name} (${args.provider}/${args.boardToken}), ` +
      `enabled=${enabled}, pollIntervalMinutes=${pollIntervalMinutes}. ` +
      `next_poll_at is NULL, so it will be picked up on the next scheduler tick.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
