#!/usr/bin/env node
// Ops script: source health table (spec §16.2), printed to the terminal
// instead of served behind a GET /health route -- there is no HTTP admin
// surface, ever (spec §13.5/§14.1). Columns: Company, Provider, Last
// success, Next poll, Jobs, Failures, Status. Status is derived at read
// time from `enabled` + `consecutive_failures` + latest run status, not a
// stored column -- same reasoning sources-repo.ts already applies to
// markSourceSuccess/markSourceFailure (consecutive_failures is a raw
// counter; "degraded"/"healthy" is a read-time judgment on top of it).
//
// Usage:
//   node infrastructure/scripts/source-health.mjs [--remote]

import { d1Execute } from "./lib/d1-exec.mjs";

/** consecutive_failures at or above this is shown as "degraded" rather
 * than "healthy" -- matches the ingest-consumer's config-error path,
 * which disables a source outright rather than incrementing forever, so
 * in practice a source rarely accumulates many failures before enabled
 * flips to 0. This threshold is for the case where transient failures
 * (429/5xx) keep recurring without ever crossing into a hard config
 * error. */
const DEGRADED_FAILURE_THRESHOLD = 3;

function deriveStatus(row) {
  if (row.enabled === 0) return "disabled";
  if (row.consecutive_failures >= DEGRADED_FAILURE_THRESHOLD) return "degraded";
  if (row.last_run_status === "failed_final") return "failed";
  return "healthy";
}

function pad(value, width) {
  const s = String(value ?? "—");
  return s.length >= width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
}

async function main() {
  const args = process.argv.slice(2);
  const local = !args.includes("--remote");

  // One row per source, with its company name, provider/board_token,
  // total normalized jobs seen (via source_runs sums), and its most
  // recent run's status -- computed with subqueries rather than a JOIN +
  // GROUP BY across job_observations, since we only need aggregates
  // already stored per-run in source_runs, not a fresh count over every
  // observation row.
  const rows = await d1Execute(
    `SELECT
       s.id,
       s.provider,
       s.board_token,
       s.enabled,
       s.consecutive_failures,
       s.last_success_at,
       s.next_poll_at,
       c.display_name AS company_name,
       (SELECT COALESCE(SUM(jobs_normalized), 0) FROM source_runs WHERE source_id = s.id) AS total_jobs_normalized,
       (SELECT status FROM source_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) AS last_run_status
     FROM sources s
     JOIN companies c ON c.id = s.company_id
     ORDER BY c.display_name ASC, s.provider ASC`,
    { local },
  );

  if (rows.length === 0) {
    console.log("No sources found.");
    return;
  }

  const header = [
    pad("Company", 24),
    pad("Provider", 16),
    pad("Last success", 21),
    pad("Next poll", 21),
    pad("Jobs", 6),
    pad("Failures", 9),
    pad("Status", 10),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        pad(row.company_name, 24),
        pad(`${row.provider}/${row.board_token}`, 16),
        pad(row.last_success_at, 21),
        pad(row.next_poll_at, 21),
        pad(row.total_jobs_normalized, 6),
        pad(row.consecutive_failures, 9),
        pad(deriveStatus(row), 10),
      ].join(" "),
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
