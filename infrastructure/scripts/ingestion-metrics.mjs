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
//      same location_mode/location, and same requisition identifier if
//      available (spec §7.4 / §515). jobs.title_normalized and
//      jobs.location_mode/location_raw exist and are queried below;
//      requisitionId does NOT -- packages/domain/src/job.ts parses it
//      from adapter payloads but no jobs-repo.ts column or migration
//      ever persists it (confirmed 2026-08-05, not assumed). This
//      script's "likely duplicate" count is therefore title+location+
//      company only, an approximation of spec §7's full rule, not the
//      rule itself -- printed with an explicit caveat rather than
//      silently passed off as the complete metric.
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

  const likelyDupRows = await d1Execute(
    `SELECT company_id, title_normalized, location_mode, location_raw, COUNT(*) AS n
     FROM jobs
     WHERE first_seen_at >= ${sinceLit}
     GROUP BY company_id, title_normalized, location_mode, location_raw
     HAVING COUNT(*) > 1`,
    { local },
  );

  const totalRuns = Number(runStats?.total_runs ?? 0);
  const successRuns = Number(runStats?.success_runs ?? 0);
  const totalJobs = Number(jobStats?.total_jobs ?? 0);
  const likelyDupJobs = likelyDupRows.reduce((sum, r) => sum + Number(r.n), 0);

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
      `Likely-duplicate rate (title+location+company match): ${dupPct}% (${likelyDupJobs}/${totalJobs}) -- target < 1% (spec §15)`,
    );
    console.log("  CAVEAT: approximates spec §7's rule (title+location+requisitionId). requisitionId is");
    console.log("  parsed from adapter payloads but never persisted to jobs -- this number omits that field.");
  }

  if (likelyDupRows.length > 0) {
    console.log("");
    console.log("Likely-duplicate groups:");
    for (const r of likelyDupRows) {
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
