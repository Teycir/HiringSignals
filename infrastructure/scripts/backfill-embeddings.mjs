#!/usr/bin/env node
// Ops script: backfill Vectorize embeddings for existing jobs rows
// (ROADMAP.md Milestone I.3, spec §9.4). Plain Node .mjs, not a Worker
// route -- there is no live AI/VECTORIZE binding available outside a
// Worker (same "no live binding outside wrangler dev/a deployed Worker"
// reasoning infrastructure/scripts/lib/d1-exec.mjs already documents for
// D1, and update-source.mjs's --run-now for the queue side).
//
// Deliberately does NOT reintroduce an authenticated /admin/* HTTP route
// the way ArxivExplorer's scripts/reembed-with-cf-ai.ts does (its own
// /admin/papers/all + /admin/embed-and-upsert, guarded by an
// x-admin-secret header) -- this repo's spec explicitly killed all
// /admin/* surface and auth (§13.5/§14.1: no login, every /api/v1/*
// route is public/unauthenticated, permanently), and Milestone I.3's own
// task list is unambiguous that this script must not recreate it. So
// this script instead calls Workers AI and Vectorize directly over their
// REST API (api.cloudflare.com), the same pattern ArxivExplorer's
// scripts/debug-vectorize.ts already uses for its own direct (non-admin)
// diagnostic calls -- an Authorization: Bearer <token> header is
// unavoidable here (Cloudflare's account-scoped REST API always
// requires one; there is no tokenless variant), sourced from CF_TOKEN in
// a gitignored .env.local (see .env.local.example at the repo root),
// same convention ArxivExplorer's own scripts use. D1 reads still go
// through the existing wrangler-shell lib/d1-exec.mjs, unrelated to this
// token.
//
// No embedded_at/vector_id tracking column exists on the jobs table
// (checked infrastructure/d1/migrations/0001_initial_schema.sql; not
// something I.2 added, and out of scope to add here as a side effect of
// I.3). Rather than build an ad hoc local ledger of "already backfilled"
// job ids, this script leans on VECTORIZE.upsert's confirmed
// idempotency-on-vector-ID (see ROADMAP.md's I.2 entry for the citation
// against Cloudflare's current Vectorize docs) -- every run re-embeds
// and overwrites every selected job, safe to re-run in full, same
// "safe to re-run" guarantee reembed-with-cf-ai.ts documents for its own
// script, just without needing a companion bookkeeping table to get it.
//
// Usage:
//   CF_TOKEN=xxx node infrastructure/scripts/backfill-embeddings.mjs
//   CF_TOKEN=xxx node infrastructure/scripts/backfill-embeddings.mjs --batch 20
//   CF_TOKEN=xxx node infrastructure/scripts/backfill-embeddings.mjs --remote
//   CF_TOKEN=xxx node infrastructure/scripts/backfill-embeddings.mjs --status active
//
// CF_TOKEN can also be left out of the environment and instead placed in
// .env.local at the repo root (gitignored) -- this script reads it from
// there if the env var itself is unset, same as ArxivExplorer's
// scripts/debug-vectorize.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { d1Execute, sqlString } from "./lib/d1-exec.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CF_ACCOUNT_ID = "c62f54368e3f6a1f503afa434771b7e4"; // apps/api/wrangler.toml's account_id
const VECTORIZE_INDEX = "hiring-signals-jobs"; // apps/api/wrangler.toml's [[vectorize]] index_name
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // apps/api/wrangler.toml's [vars].EMBEDDING_MODEL
const DESCRIPTION_TRUNCATE_CHARS = 2000; // mirrors packages/domain/src/embedding-text.ts's own constant -- keep these two in sync by hand, this script can't import that file (plain Node, not bundled)
const DELAY_MS = 500; // between batches -- Workers AI rate-limit headroom, same value ArxivExplorer's reembed-with-cf-ai.ts uses


// Reads CF_TOKEN from .env.local at the repo root if not already in the
// environment -- same lightweight inline .env parser ArxivExplorer's
// scripts/debug-vectorize.ts uses (no dotenv dependency added just for
// one optional var).
function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, ".env.local");
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim();
    }
  }
  return env;
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
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Re-implementation of packages/domain/src/embedding-text.ts's
 * buildJobEmbeddingText, field-for-field identical (same field order,
 * same truncation length/point) -- this script cannot import that TS
 * file directly (plain Node .mjs, no bundler here, same constraint
 * documented at the top of lib/d1-exec.mjs for why D1 queries are
 * duplicated by hand rather than imported). If embedding-text.ts's
 * logic ever changes, this function must be updated to match by hand.
 * Operates on a raw D1 row's column names (title_raw/role_primary/
 * department_raw/location_raw/description_text) rather than
 * JobEmbeddingInput's camelCase shape, since that's what
 * `wrangler d1 execute --json` actually returns.
 */
function buildJobEmbeddingText(row) {
  const lines = [row.title_raw];
  if (row.role_primary) lines.push(row.role_primary);
  if (row.department_raw) lines.push(row.department_raw);
  if (row.location_raw) lines.push(row.location_raw);
  if (row.description_text) lines.push(String(row.description_text).slice(0, DESCRIPTION_TRUNCATE_CHARS));
  return lines.join("\n");
}


/**
 * Fetches jobs to backfill. --status filters to one status
 * (active/possibly_closed/closed); omitted means all jobs regardless of
 * status -- a closed job is still a legitimate semantic-search result
 * for "what did this company used to hire for", spec §9.4 doesn't scope
 * search to active-only, so the default is deliberately unfiltered.
 */
async function fetchJobsToBackfill({ local, status }) {
  const where = status ? ` WHERE status = ${sqlString(status)}` : "";
  return d1Execute(
    `SELECT id, company_id, title_raw, role_primary, department_raw,
            location_raw, location_mode, description_text, status, posted_at,
            first_seen_at
     FROM jobs${where}
     ORDER BY first_seen_at ASC`,
    { local },
  );
}

/**
 * Calls Workers AI's REST endpoint directly (no Worker binding
 * available here) -- same request shape as env.AI.run(EMBEDDING_MODEL,
 * { text: [...] }) inside a Worker, confirmed against
 * developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5's own curl
 * example: POST .../ai/run/<model>, Authorization: Bearer <token>,
 * { text: string[] } body. The REST response wraps the binding's own
 * postProcessedOutputs shape one level deeper under "result"
 * (top-level success/errors/result envelope, standard Cloudflare API
 * shape) -- unwrapped below so callers see the same { data: number[][] }
 * shape ingest-consumer.ts's embedAndUpsertJob already works with.
 */
async function embedTexts(texts, { cfToken }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Workers AI embed failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(`Workers AI embed failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

/**
 * Upserts vectors via Vectorize's v2 REST endpoint, which -- unlike the
 * VECTORIZE.upsert(vectors: VectorizeVector[]) binding method used
 * inside a Worker -- takes an NDJSON body (Content-Type:
 * application/x-ndjson, one JSON object per line, no enclosing array),
 * confirmed against developers.cloudflare.com/api/resources/vectorize/
 * subresources/indexes/methods/upsert's own parameter docs. Upserts are
 * asynchronous here (returns a mutationId, not an immediate count) --
 * different from the binding's synchronous VectorizeVectorMutation
 * return shape (spec's own VectorizeIndex vs Vectorize class split,
 * documented in ROADMAP.md's I.2 entry); this script doesn't poll for
 * completion, matching the "typically a few seconds" async-availability
 * note in Cloudflare's own Vectorize docs -- fire-and-forget per batch
 * is acceptable for an ops backfill, unlike the request-path binding
 * call I.2 makes.
 */
async function upsertVectors(vectors, { cfToken }) {
  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "Content-Type": "application/x-ndjson",
      },
      body: ndjson,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vectorize upsert failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(`Vectorize upsert failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}


/**
 * Embeds and upserts one batch. Metadata shape matches I.2's
 * embedAndUpsertJob exactly (companyId/status/postedAt always,
 * roleCategory/locationMode omitted rather than sent as empty/null when
 * absent -- VectorizeVectorMetadata doesn't accept undefined, and an
 * omitted key is cleaner than a placeholder value that would then need
 * filtering out at query time). postedAt falls back to first_seen_at
 * when the source never provided one, mirroring ingest-consumer.ts's own
 * anchorDate fallback chain for freshness scoring (observedAt isn't
 * available here at backfill time, so the chain is one link shorter:
 * job.posted_at ?? job.first_seen_at, never left undefined either way
 * since first_seen_at is NOT NULL in the schema).
 */
async function backfillBatch(jobs, { cfToken }) {
  const texts = jobs.map((job) => buildJobEmbeddingText(job));
  const embedResult = await embedTexts(texts, { cfToken });
  if (!embedResult.data || embedResult.data.length !== jobs.length) {
    throw new Error(
      `Embedding count mismatch: sent ${jobs.length} texts, got ${embedResult.data?.length ?? 0} back`,
    );
  }

  const vectors = jobs.map((job, i) => {
    const metadata = {
      companyId: job.company_id,
      status: job.status,
      postedAt: job.posted_at ?? job.first_seen_at,
    };
    if (job.role_primary) metadata.roleCategory = job.role_primary;
    if (job.location_mode) metadata.locationMode = job.location_mode;
    return { id: job.id, values: embedResult.data[i], metadata };
  });

  await upsertVectors(vectors, { cfToken });
  return { ok: jobs.length, failed: 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envLocal = loadEnvLocal();
  const cfToken = process.env.CF_TOKEN || envLocal.CF_TOKEN || "";
  const batchSize = args.batch ? Number(args.batch) : 20;
  const local = !args.remote;

  if (!cfToken) {
    console.error("Missing CF_TOKEN. Set it in the environment or in .env.local at the repo root.");
    console.error("See .env.local.example for the token permissions required.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nbackfill-embeddings`);
  console.log(`  D1 source: ${local ? "local" : "remote"} (hiring-signals)`);
  console.log(`  Vectorize index: ${VECTORIZE_INDEX}`);
  console.log(`  batch size: ${batchSize}`);
  if (args.status) console.log(`  status filter: ${args.status}`);
  console.log("");

  const jobs = await fetchJobsToBackfill({ local, status: args.status });
  console.log(`Jobs to embed: ${jobs.length}\n`);

  if (jobs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let totalOk = 0;
  let totalFailed = 0;
  const chunks = Math.ceil(jobs.length / batchSize);

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const chunk = Math.ceil((i + 1) / batchSize);
    try {
      const { ok, failed } = await backfillBatch(batch, { cfToken });
      totalOk += ok;
      totalFailed += failed;
    } catch (err) {
      console.error(`\n  Batch ${chunk} failed: ${err.message}`);
      totalFailed += batch.length;
    }
    process.stdout.write(`\r  chunk ${chunk}/${chunks} -- ok ${totalOk}  failed ${totalFailed}  / ${jobs.length}`);
    if (i + batchSize < jobs.length) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n\nDone -- embedded: ${totalOk}, failed: ${totalFailed}`);
  if (totalFailed > 0) {
    console.log("Re-run to retry (VECTORIZE.upsert overwrites safely by vector ID, confirmed idempotent).");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
