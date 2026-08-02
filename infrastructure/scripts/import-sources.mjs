#!/usr/bin/env node
// Ops script: bulk source onboarding from a CSV file (ROADMAP.md
// Milestone M.1, spec §2.2 P1 "Manual company/source onboarding from a
// CSV", spec §22 open decision 2 -- registry growth bottleneck). Adding
// N companies today requires N separate add-company.mjs + add-source.mjs
// invocations; this script takes one CSV and does both in one pass.
//
// Usage:
//   node infrastructure/scripts/import-sources.mjs <csv-file-path> [--remote]
//
// CSV columns (header row required, any order):
//   company_slug, company_display_name, company_domain (optional),
//   provider, board_token, public_url, poll_interval_minutes (optional,
//   default 90)
//
// One row = one source. Multiple sources for the same company share the
// same company_slug -- the company is only created once, on its first
// occurrence.
//
// Same .mjs-over-`wrangler d1 execute --json` pattern as every other ops
// script (no live D1Database binding outside a Worker -- see
// lib/d1-exec.mjs's header). Same duplicate-detection reasoning as
// add-company.mjs/add-source.mjs: this script can't import
// DuplicateCompanyError/DuplicateSourceError directly, so it re-checks
// via SELECT first, same as those two scripts already do -- and, same as
// those two, treats a UNIQUE-constraint race on the actual INSERT as the
// authoritative outcome, not just the pre-check.
//
// Two-pass design: pass 1 parses and validates the ENTIRE CSV in memory
// (no writes yet), prints a per-row plan and a validity summary, and
// only pass 2 (if pass 1 found zero invalid rows) touches the database.
// This mirrors update-source.mjs's "read the current state, decide,
// then write" shape and gives a caller a chance to see the full plan
// before anything is written -- there is no interactive TTY prompt in
// this repo's ops scripts (checked: no script uses `readline`), so
// "confirm before writing" here means "the full plan is printed and
// pass 2 only runs if pass 1 is 100% clean," not an interactive y/n.
//
// CSV duplicates (same provider+board_token appearing twice in the same
// file, or a row whose company_slug already exists in D1) are
// skip-with-warning, not fatal -- re-running the same CSV twice is safe
// and idempotent, same guarantee add-company.mjs/add-source.mjs already
// give per-invocation.

import { readFileSync } from "node:fs";
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
// (same manually-synced-copy caveat as add-source.mjs's own copy of this
// list -- these scripts run outside any bundler that could import
// packages/domain directly).

const REQUIRED_COLUMNS = [
  "company_slug",
  "company_display_name",
  "provider",
  "board_token",
  "public_url",
];
const OPTIONAL_COLUMNS = ["company_domain", "poll_interval_minutes"];
const DEFAULT_POLL_INTERVAL_MINUTES = 90;

/**
 * Minimal RFC 4180 CSV row parser -- no external dependency, same
 * "small hand-rolled encoder/decoder is less surface area than a CSV
 * library for one script" reasoning as lib/text/csv.ts's writer (which
 * this mirrors but does not import, since that file lives under lib/
 * and is written for the Workers CSV *export* path, not read by ops
 * scripts). Handles quoted fields containing commas, embedded double
 * quotes ("" -> "), and CRLF/LF line endings. Not a streaming
 * parser -- import CSVs are expected to be at most low-thousands of
 * rows (one company + one source config per row), well within
 * readFileSync's comfortable range.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(field);
    field = "";
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue; // swallow bare \r; \n (whether from \r\n or lone \n) ends the row below
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Final row: only emit if there's a pending field/row (guards a
  // trailing newline at EOF from producing a spurious empty last row).
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

function parseArgs(argv) {
  const args = { remote: false, csvPath: undefined };
  for (const a of argv) {
    if (a === "--remote") {
      args.remote = true;
      continue;
    }
    if (!a.startsWith("--") && args.csvPath === undefined) {
      args.csvPath = a;
      continue;
    }
  }
  return args;
}

/** Parses the raw CSV text into an array of { rowNumber, data } where
 * data is a header-keyed object, plus validates structure (header
 * present, required columns present, correct column count per row). */
function loadCsvRows(csvText) {
  const parsed = parseCsv(csvText);
  if (parsed.length === 0) {
    throw new Error("CSV file is empty.");
  }
  const header = parsed[0].map((h) => h.trim());
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    throw new Error(
      `CSV header is missing required column(s): ${missingColumns.join(", ")}. ` +
        `Required: ${REQUIRED_COLUMNS.join(", ")}. Optional: ${OPTIONAL_COLUMNS.join(", ")}.`,
    );
  }

  const dataRows = parsed.slice(1).filter((r) => !(r.length === 1 && r[0] === ""));
  return dataRows.map((cells, idx) => {
    const rowNumber = idx + 2; // +1 for header row, +1 for 1-indexing
    const data = {};
    header.forEach((col, colIdx) => {
      data[col] = (cells[colIdx] ?? "").trim();
    });
    return { rowNumber, data };
  });
}

/**
 * Validates one row's required fields, provider enum, and numeric
 * poll_interval_minutes (if present). Returns an array of error strings
 * (empty = valid). Pure/no I/O -- cross-row duplicate detection and
 * existing-in-D1 checks happen separately in planImport, since those
 * need the full row set / a live DB round trip.
 */
function validateRowShape(data) {
  const errors = [];
  for (const col of REQUIRED_COLUMNS) {
    if (!data[col] || data[col].trim() === "") {
      errors.push(`missing/blank required column "${col}"`);
    }
  }
  if (data.provider && !ATS_PROVIDERS.includes(data.provider)) {
    errors.push(`unknown provider "${data.provider}" (must be one of: ${ATS_PROVIDERS.join(", ")})`);
  }
  if (data.poll_interval_minutes && data.poll_interval_minutes.trim() !== "") {
    const n = Number(data.poll_interval_minutes);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`poll_interval_minutes "${data.poll_interval_minutes}" is not a positive number`);
    }
  }
  return errors;
}

/**
 * Builds the full import plan against the current D1 state: for each
 * row, decide OK / SKIP (duplicate) / ERROR (invalid), without writing
 * anything. Existing companies/sources are looked up once per distinct
 * company_slug / (provider, board_token) pair rather than once per row,
 * since a CSV commonly has many rows sharing one company_slug (multiple
 * sources per company).
 */
async function planImport(rows, { local }) {
  const plan = [];
  const seenCompanySlugs = new Map(); // slug -> { existsInDb, displayName }
  const seenSourceKeys = new Set(); // `${provider}::${boardToken}` seen earlier in THIS file
  // Tracks slugs this plan has already committed to creating (its first
  // OK row with needsCompanyCreate=true) so a LATER OK row sharing the
  // same slug is labeled "existing company" in the printed plan/summary
  // -- executeRow only ever creates each slug once (via its own
  // createdCompanyIds map), so the plan's per-row label should reflect
  // that effective one-create-per-slug outcome, not "not yet in the live
  // DB at lookup time" (which would make every row after the first for a
  // brand-new company misleadingly say "new company" again).
  const slugsPlannedForCreation = new Set();

  for (const { rowNumber, data } of rows) {
    const shapeErrors = validateRowShape(data);
    if (shapeErrors.length > 0) {
      plan.push({ rowNumber, data, outcome: "ERROR", reasons: shapeErrors });
      continue;
    }

    const sourceKey = `${data.provider}::${data.board_token}`;
    if (seenSourceKeys.has(sourceKey)) {
      plan.push({
        rowNumber,
        data,
        outcome: "SKIP",
        reasons: [`duplicate provider+board_token "${sourceKey}" already seen earlier in this CSV`],
      });
      continue;
    }

    let companyInfo = seenCompanySlugs.get(data.company_slug);
    if (!companyInfo) {
      const existing = await d1Execute(
        `SELECT id, display_name FROM companies WHERE slug = ${sqlString(data.company_slug)}`,
        { local },
      );
      companyInfo =
        existing.length > 0
          ? { existsInDb: true, id: existing[0].id, displayName: existing[0].display_name }
          : { existsInDb: false, id: null, displayName: data.company_display_name };
      seenCompanySlugs.set(data.company_slug, companyInfo);
    }

    const existingSource = await d1Execute(
      `SELECT id FROM sources WHERE provider = ${sqlString(data.provider)} AND board_token = ${sqlString(data.board_token)}`,
      { local },
    );
    if (existingSource.length > 0) {
      seenSourceKeys.add(sourceKey);
      plan.push({
        rowNumber,
        data,
        outcome: "SKIP",
        reasons: [
          `source already exists for provider="${data.provider}" boardToken="${data.board_token}" (id=${existingSource[0].id})`,
        ],
      });
      continue;
    }

    seenSourceKeys.add(sourceKey);
    const needsCompanyCreate = !companyInfo.existsInDb && !slugsPlannedForCreation.has(data.company_slug);
    if (needsCompanyCreate) slugsPlannedForCreation.add(data.company_slug);
    plan.push({
      rowNumber,
      data,
      outcome: "OK",
      reasons: [],
      needsCompanyCreate,
      companySlug: data.company_slug,
    });
  }

  return plan;
}

/** Executes an OK-outcome plan row: creates the company first if this is
 * its first OK row (tracked via createdCompanyIds so a company shared
 * by multiple rows is only INSERTed once), then creates the source.
 * Mirrors add-company.mjs / add-source.mjs's own INSERT shape exactly
 * so a row processed here behaves identically to running those two
 * scripts by hand. */
async function executeRow(item, { local, createdCompanyIds }) {
  const { data } = item;
  let companyId = createdCompanyIds.get(data.company_slug);

  if (!companyId) {
    if (item.needsCompanyCreate) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        await d1Execute(
          `INSERT INTO companies (id, slug, display_name, domain, industry, employee_band, created_at, updated_at)
           VALUES (${sqlString(id)}, ${sqlString(data.company_slug)}, ${sqlString(data.company_display_name)},
                   ${sqlString(data.company_domain || null)}, NULL, NULL, ${sqlString(now)}, ${sqlString(now)})`,
          { local },
        );
        companyId = id;
      } catch (err) {
        if (/UNIQUE constraint failed/i.test(err.message)) {
          // Same TOCTOU race add-company.mjs documents: another row/process
          // created this slug between planImport's SELECT and this INSERT.
          const dup = await d1Execute(
            `SELECT id FROM companies WHERE slug = ${sqlString(data.company_slug)}`,
            { local },
          );
          companyId = dup[0]?.id;
          if (!companyId) throw err;
        } else {
          throw err;
        }
      }
    } else {
      const existing = await d1Execute(
        `SELECT id FROM companies WHERE slug = ${sqlString(data.company_slug)}`,
        { local },
      );
      companyId = existing[0]?.id;
      if (!companyId) {
        throw new Error(`Row ${item.rowNumber}: company_slug "${data.company_slug}" not found at write time.`);
      }
    }
    createdCompanyIds.set(data.company_slug, companyId);
  }

  const sourceId = crypto.randomUUID();
  const pollIntervalMinutes = data.poll_interval_minutes
    ? Number(data.poll_interval_minutes)
    : DEFAULT_POLL_INTERVAL_MINUTES;

  try {
    await d1Execute(
      `INSERT INTO sources
         (id, company_id, provider, board_token, public_url, enabled,
          poll_interval_minutes, next_poll_at, last_success_at, consecutive_failures)
       VALUES (${sqlString(sourceId)}, ${sqlString(companyId)}, ${sqlString(data.provider)},
               ${sqlString(data.board_token)}, ${sqlString(data.public_url)}, ${sqlBool(true)},
               ${pollIntervalMinutes}, NULL, NULL, 0)`,
      { local },
    );
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) {
      // Same TOCTOU race as the company branch above, for (provider,
      // board_token) instead of slug -- treat as a skip, not a hard
      // failure, consistent with this script's overall
      // duplicates-are-skips policy.
      return { skipped: true, reason: "source created concurrently between plan and write" };
    }
    throw err;
  }

  return { skipped: false, companyId, sourceId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csvPath) {
    console.error("Missing required argument: <csv-file-path>");
    console.error("Usage: node import-sources.mjs <csv-file-path> [--remote]");
    process.exitCode = 1;
    return;
  }

  let csvText;
  try {
    csvText = readFileSync(args.csvPath, "utf8");
  } catch (err) {
    console.error(`Could not read CSV file "${args.csvPath}": ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let rows;
  try {
    rows = loadCsvRows(csvText);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (rows.length === 0) {
    console.log("CSV has a header row but no data rows. Nothing to do.");
    return;
  }

  const local = !args.remote;
  console.log(
    `Parsed ${rows.length} data row(s) from ${args.csvPath}. Validating against ${local ? "LOCAL" : "REMOTE"} D1...`,
  );

  const plan = await planImport(rows, { local });

  let okCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  for (const item of plan) {
    const prefix = `[${item.outcome}] row ${item.rowNumber}`;
    if (item.outcome === "OK") {
      okCount++;
      const companyNote = item.needsCompanyCreate ? "new company" : "existing company";
      console.log(
        `${prefix}: ${item.data.provider}/${item.data.board_token} for "${item.companySlug}" (${companyNote})`,
      );
    } else if (item.outcome === "SKIP") {
      skipCount++;
      console.log(`${prefix}: ${item.reasons.join("; ")}`);
    } else {
      errorCount++;
      console.log(`${prefix}: ${item.reasons.join("; ")}`);
    }
  }

  console.log(`\nSummary: ${okCount} to create, ${skipCount} to skip (duplicates), ${errorCount} invalid.`);

  if (errorCount > 0) {
    console.error(
      `\nAborting: ${errorCount} row(s) failed validation. Fix the CSV and re-run -- no rows were written.`,
    );
    process.exitCode = 1;
    return;
  }

  if (okCount === 0) {
    console.log("\nNothing to create -- every row is a duplicate. No rows were written.");
    return;
  }

  console.log(`\nWriting ${okCount} new source(s)${local ? "" : " to REMOTE D1"}...`);
  const createdCompanyIds = new Map();
  let created = 0;
  let concurrentlySkipped = 0;
  for (const item of plan) {
    if (item.outcome !== "OK") continue;
    const result = await executeRow(item, { local, createdCompanyIds });
    if (result.skipped) {
      concurrentlySkipped++;
      console.log(`[SKIP] row ${item.rowNumber}: ${result.reason}`);
    } else {
      created++;
      console.log(`[OK] row ${item.rowNumber}: created source ${result.sourceId} (company ${result.companyId})`);
    }
  }

  console.log(
    `\nDone. Created ${created} source(s)` +
      (concurrentlySkipped > 0 ? `, ${concurrentlySkipped} skipped due to a concurrent duplicate` : "") +
      `, ${skipCount} pre-existing duplicate(s) skipped, ${errorCount} invalid.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
