#!/usr/bin/env node
// Ops script: source health table (spec §16.2), printed to the terminal
// instead of served behind a GET /health route -- there is no HTTP admin
// surface, ever (spec §13.5/§14.1). Columns: Company, Provider, Last
// success, Next poll, Jobs, Failures, p50 latency, Status. Status is
// derived at read time from `enabled` + `consecutive_failures` + latest
// run status, not a stored column -- same reasoning sources-repo.ts
// already applies to markSourceSuccess/markSourceFailure
// (consecutive_failures is a raw counter; "degraded"/"healthy" is a
// read-time judgment on top of it).
//
// p50 latency (ROADMAP.md K.2, spec §15's detection-latency metric:
// "posting live -> visible to API consumers, p50 <= effective per-source
// pollIntervalMinutes") is computed inline as a correlated scalar
// subquery per source row, duplicating packages/db's
// getDetectionLatencyStats query shape by hand -- same reasoning as this
// file's header comment on d1-exec.mjs: ops scripts shell out via
// `wrangler d1 execute`, they cannot import the real D1Client-based repo
// functions, so the SQL is kept in sync by hand rather than shared code.
// Folded into the same single SELECT as every other column (rather than
// a second d1Execute round trip) because this script already favors
// subqueries over multiple wrangler shell-outs (see total_jobs_normalized
// and last_run_status below) for exactly this reason -- each d1Execute
// call spawns a new `wrangler d1 execute` process.
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

/** Minutes a source_runs row can sit at status='running' before this
 * script treats it as stuck rather than "still in progress" (ROADMAP.md
 * G.3/§16.3.6, found 2026-08-11: a genuine Cloudflare per-invocation
 * subrequest-cap error can crash a run *and* its own failure-recording
 * fallback in the same invocation -- see ingest-consumer.ts's own fix --
 * leaving the row at 'running' forever, and this script's deriveStatus()
 * previously had no branch that could ever notice, so a source stuck
 * this way still showed "healthy, 0 failures"). 90 minutes is
 * deliberately generous relative to the shortest configured
 * poll_interval_minutes (360, i.e. 6h) seen in production as of this
 * fix -- a legitimate run should finish in well under an hour even for
 * the largest observed board (openai, ~732 jobs); this threshold exists
 * to catch "never resolved," not to flag an unusually slow-but-real run. */
const STALE_RUNNING_MINUTES = 90;

function deriveStatus(row) {
  if (row.enabled === 0) return "disabled";
  if (row.last_run_status === "running" && row.running_minutes >= STALE_RUNNING_MINUTES) {
    return "stuck";
  }
  if (row.consecutive_failures >= DEGRADED_FAILURE_THRESHOLD) return "degraded";
  if (row.last_run_status === "failed_final") return "failed";
  return "healthy";
}

function pad(value, width) {
  const s = String(value ?? "—");
  return s.length >= width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
}

/** p50_latency_minutes comes back as a float from julianday() arithmetic
 * (e.g. 10.0000000745058) -- round to the nearest whole minute for
 * display, this is an ops-visibility table, not a precision metric. */
function formatLatency(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  return `${Math.round(minutes)}m`;
}

async function main() {
  const args = process.argv.slice(2);
  const local = !args.includes("--remote");

  // One row per source, with its company name, provider/board_token,
  // total normalized jobs seen (via source_runs sums), its most recent
  // run's status, and its p50 detection latency -- computed with
  // subqueries rather than a JOIN + GROUP BY across job_observations,
  // since we only need aggregates already stored per-run in source_runs
  // (or derivable per-source) not a fresh count over every observation
  // row joined at the top level.
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
       (SELECT status FROM source_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) AS last_run_status,
       (SELECT (julianday('now') - julianday(started_at)) * 24 * 60 FROM source_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) AS running_minutes,
       (
         WITH fo AS (
           SELECT jo.job_id, MIN(jo.observed_at) AS first_observed_at
           FROM job_observations jo
           JOIN jobs jj ON jj.id = jo.job_id
           WHERE jj.source_id = s.id
           GROUP BY jo.job_id
         ),
         lat AS (
           SELECT
             (julianday(fo.first_observed_at) - julianday(sr.started_at)) * 24 * 60 AS latency_minutes,
             ROW_NUMBER() OVER (ORDER BY (julianday(fo.first_observed_at) - julianday(sr.started_at))) AS rn,
             COUNT(*) OVER () AS total
           FROM fo
           JOIN job_observations jo ON jo.job_id = fo.job_id AND jo.observed_at = fo.first_observed_at
           JOIN source_runs sr ON sr.id = jo.source_run_id
         )
         SELECT latency_minutes FROM lat WHERE rn = CAST((0.50 * (total - 1)) AS INTEGER) + 1 LIMIT 1
       ) AS p50_latency_minutes
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
    pad("p50 latency", 12),
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
        pad(formatLatency(row.p50_latency_minutes), 12),
        pad(deriveStatus(row), 10),
      ].join(" "),
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
