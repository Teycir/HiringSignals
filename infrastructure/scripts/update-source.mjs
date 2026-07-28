#!/usr/bin/env node
// Ops script: update an existing source (ROADMAP.md Milestone D, spec
// §13.5). Enable/disable, change poll cadence, fix a stale public URL,
// or force a source to be picked up on the next scheduler tick.
//
// Usage:
//   node infrastructure/scripts/update-source.mjs --id <source-id> [--enable | --disable]
//     [--poll-interval-minutes 360] [--public-url <url>] [--remote]
//
//   node infrastructure/scripts/update-source.mjs --id <source-id> --run-now [--remote]
//     Sets next_poll_at to NULL so getDueSources() picks it up on the very
//     next scheduler cron tick. This is the "manual ingestion trigger"
//     mechanism (spec §13.5) -- see the --run-now branch below for why it
//     works this way instead of directly enqueueing a queue message.

import { d1Execute, sqlString, sqlBool } from "./lib/d1-exec.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--enable") {
      args.enabled = true;
      continue;
    }
    if (a === "--disable") {
      args.enabled = false;
      continue;
    }
    if (a === "--run-now") {
      args.runNow = true;
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

  if (!args.id) {
    console.error("Missing required argument: --id <source-id>");
    process.exitCode = 1;
    return;
  }

  const local = !args.remote;

  const rows = await d1Execute(`SELECT id, provider, board_token FROM sources WHERE id = ${sqlString(args.id)}`, {
    local,
  });
  if (rows.length === 0) {
    console.error(`No source found with id "${args.id}".`);
    process.exitCode = 1;
    return;
  }

  const sets = [];
  if (args.enabled !== undefined) sets.push(`enabled = ${sqlBool(args.enabled)}`);
  if (args.pollIntervalMinutes !== undefined) sets.push(`poll_interval_minutes = ${Number(args.pollIntervalMinutes)}`);
  if (args.publicUrl !== undefined) sets.push(`public_url = ${sqlString(args.publicUrl)}`);

  // --run-now: force this source to look "due" without waiting for
  // poll_interval_minutes to elapse. This is deliberately NOT the same
  // as directly enqueueing an IngestMessage onto INGEST_QUEUE, because
  // Cloudflare Queues can only be sent to via a live Queue *binding*,
  // which only exists inside a Worker (wrangler dev / a deployed
  // Worker) -- a plain Node ops script has no way to construct one.
  // Reimplementing the ingest-consumer's pipeline logic here (bypassing
  // the queue) was considered and rejected: it would duplicate ~500
  // lines of idempotency/lifecycle/classification/signal logic outside
  // apps/api/src/jobs/ingest-consumer.ts, and any drift between the two
  // copies would be a silent correctness bug. Setting next_poll_at to
  // NULL and letting the real 15-minute cron (or `wrangler dev
  // --test-scheduled`, for a local manual trigger) enqueue it through
  // the actual scheduler code path is slower (up to one cron interval)
  // but exercises the same, single, real pipeline.
  if (args.runNow) sets.push(`next_poll_at = NULL`);

  if (sets.length === 0) {
    console.error("Nothing to update -- pass --enable/--disable, --poll-interval-minutes, --public-url, or --run-now.");
    process.exitCode = 1;
    return;
  }

  await d1Execute(`UPDATE sources SET ${sets.join(", ")} WHERE id = ${sqlString(args.id)}`, { local });

  console.log(`Updated source ${args.id} (${rows[0].provider}/${rows[0].board_token}): ${sets.join(", ")}`);
  if (args.runNow) {
    console.log(
      "next_poll_at cleared. It will be picked up on the next scheduler cron tick (every 15 minutes), " +
        "or immediately via `wrangler dev --test-scheduled` against a running local dev server.",
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
