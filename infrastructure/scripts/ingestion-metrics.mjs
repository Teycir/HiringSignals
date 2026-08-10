#!/usr/bin/env node
// Ops script: source ingestion success rate + job duplicate rate (spec
// §15 targets: success >= 98%, duplicate rate < 1%), printed to the
// terminal -- same "no HTTP admin surface" reasoning as
// source-health.mjs (spec §13.5/§14.1). ROADMAP.md G.3's verify step
// asked for "a repeatable ops-script query... rather than a one-off
// check" for exactly this pair of numbers; this is that script, kept
// separate from source-health.mjs since it prints one aggregate summary
// rather than a per-source table.
//
// Success rate: COUNT(status='success') / COUNT(*) over source_runs in
// the lookback window. Straightforward, no caveats.
//
// Duplicate rate has two tiers per spec §7 (dedup rules):
//   1. "Hard duplicate" (same source_id + external_job_id) -- prevented
//      by the jobs table's own UNIQUE(source_id, external_job_id)
//      constraint (0001_initial_schema.sql). upsertJob() always updates
//      the existing row on a second sighting, so this can never appear
//      as two rows -- reported as a fixed 0%, not queried, since a
//      structurally-impossible thing isn't worth a query.
//   2. "Likely duplicate within a company" -- same normalized title,
//      same location_mode/location, and same requisition identifier
//      "if available" (spec §7.2, read literally: requisitionId is an
//      extra matching dimension when present on both sides, not a
//      required field -- a NULL requisitionId doesn't disqualify a
//      title+location+company match, since 5 of 8 adapters never
//      expose one). requisition_id was persisted 2026-08-09 (migration
//      0009, ROADMAP.md G.3 gap) -- this script now queries it via two
//      separate GROUP BYs rather than one, since folding a nullable
//      column into a single GROUP BY would silently bucket every
//      NULL-requisition job at a company/title/location into one
//      giant "same requisitionId" group (NULL groups with NULL in
//      SQL's GROUP BY), which is wrong per the "if available" reading
//      above. Tier 2a groups only rows where requisition_id IS NOT
//      NULL (title+location+company+requisitionId, the full spec §7
//      rule); tier 2b groups the remaining requisition_id IS NULL rows
//      (title+location+company only, the pre-migration approximation,
//      now scoped to just the rows that genuinely lack the field
//      rather than applied blanket).
//
// Usage:
//   node infrastructure/scripts/ingestion-metrics.mjs [--remote] [--since=<ISO8601>]

import { d1Execute, sqlString } from "./lib/d1-exec.mjs";

function parseArgs(argv) {
  const local = !argv.includes("--remote");
  const sinceArg = argv.find((a) => a.startsWith("--since="));
  // Default lookback: 30 days -- spec §15 doesn't state a fixed window
  // for these targets, this script's own choice, documented here.
  const since =
    sinceArg?.slice("--since=".length) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { local, since };
}

async function main() {
  const { local, since } = parseArgs(process.argv.slice(2));
  const sinceLit = sqlString(since);

  const [runStats] = await d1Execute(
    `SELECT
       COUNT(*) AS total_runs,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs
     FROM source_runs
     WHERE started_at >= ${sinceLit}`,
    { local },
  );

  const [jobStats] = await d1Execute(
    `SELECT COUNT(*) AS total_jobs FROM jobs WHERE first_seen_at >= ${sinceLit}`,
    { local },
  );

  // Tier 2a: full spec §7 rule (title+location+company+requisitionId),
  // scoped to rows that actually have a requisition_id -- see header
  // comment on why NULL requisition_id rows can't share this GROUP BY.
  const likelyDupWithReqIdRows = await d1Execute(
    `SELECT company_id, title_normalized, location_mode, location_raw, requisition_id, COUNT(*) AS n
     FROM jobs
     WHERE first_seen_at >= ${sinceLit} AND requisition_id IS NOT NULL
     GROUP BY company_id, title_normalized, location_mode, location_raw, requisition_id
     HAVING COUNT(*) > 1`,
    { local },
  );

  // Tier 2b: title+location+company approximation, scoped to rows that
  // genuinely lack a requisition_id (adapter doesn't expose one).
  const likelyDupNoReqIdRows = await d1Execute(
    `SELECT company_id, title_normalized, location_mode, location_raw, COUNT(*) AS n
     FROM jobs
     WHERE first_seen_at >= ${sinceLit} AND requisition_id IS NULL
     GROUP BY company_id, title_normalized, location_mode, location_raw
     HAVING COUNT(*) > 1`,
    { local },
  );

  const totalRuns = Number(runStats?.total_runs ?? 0);
  const successRuns = Number(runStats?.success_runs ?? 0);
  const totalJobs = Number(jobStats?.total_jobs ?? 0);
  const likelyDupWithReqIdJobs = likelyDupWithReqIdRows.reduce((sum, r) => sum + Number(r.n), 0);
  const likelyDupNoReqIdJobs = likelyDupNoReqIdRows.reduce((sum, r) => sum + Number(r.n), 0);
  const likelyDupJobs = likelyDupWithReqIdJobs + likelyDupNoReqIdJobs;

  console.log(`Ingestion metrics since ${since} (${local ? "local" : "remote"})`);
  console.log("-".repeat(60));

  if (totalRuns === 0) {
    console.log("No source_runs in this window -- success rate not measurable.");
  } else {
    const successPct = ((successRuns / totalRuns) * 100).toFixed(1);
    console.log(
      `Source run success rate: ${successPct}% (${successRuns}/${totalRuns}) -- target >= 98% (spec §15)`,
    );
  }

  console.log("Hard duplicate rate: 0% (fixed) -- jobs.UNIQUE(source_id, external_job_id) makes this");
  console.log("  structurally impossible; upsertJob() always updates on re-sighting, never inserts twice.");

  if (totalJobs === 0) {
    console.log("Likely-duplicate rate: not measurable -- 0 jobs in this window.");
  } else {
    const dupPct = ((likelyDupJobs / totalJobs) * 100).toFixed(1);
    console.log(
      `Likely-duplicate rate (spec §7 full rule): ${dupPct}% (${likelyDupJobs}/${totalJobs}) -- target < 1% (spec §15)`,
    );
    console.log(
      `  Breakdown: ${likelyDupWithReqIdJobs} via title+location+company+requisitionId, ` +
        `${likelyDupNoReqIdJobs} via title+location+company (requisitionId not available for these adapters).`,
    );
  }

  if (likelyDupWithReqIdRows.length > 0) {
    console.log("");
    console.log("Likely-duplicate groups (requisitionId matched):");
    for (const r of likelyDupWithReqIdRows) {
      console.log(
        `  [${r.n}x] company=${r.company_id} title="${r.title_normalized}" location=${r.location_mode}/${r.location_raw ?? "—"} req=${r.requisition_id}`,
      );
    }
  }

  if (likelyDupNoReqIdRows.length > 0) {
    console.log("");
    console.log("Likely-duplicate groups (title+location+company, no requisitionId):");
    for (const r of likelyDupNoReqIdRows) {
      console.log(
        `  [${r.n}x] company=${r.company_id} title="${r.title_normalized}" location=${r.location_mode}/${r.location_raw ?? "—"}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
