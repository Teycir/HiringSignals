#!/usr/bin/env node
// Ops script: build and upsert per-RoleCategory centroid vectors
// (ROADMAP.md I.5a, spec §9.4 capability 2 -- classification assist).
//
// A "centroid" here is the mean-pooled embedding of that category's seed
// phrases (infrastructure/scripts/category-centroid-seeds.json, sourced
// from packages/domain/src/role-rules.ts's PHRASE_RULES). One vector per
// RoleCategory (10 total), upserted into the *existing*
// hiring-signals-jobs Vectorize index -- no new index -- with a distinct
// metadata tag (kind: "category_centroid") so I.5b's nudge lookup can
// scope its query to centroid-only vectors, and so these vectors never
// leak into findSemanticSignalMatches/handleMoreLikeThis-equivalent
// result sets (both of those only ever query without that tag / filter
// it out, per I.5a's own ROADMAP entry).
//
// Same REST-not-binding approach as backfill-embeddings.mjs, and for the
// identical reason documented there: no live AI/VECTORIZE binding exists
// outside a deployed Worker, and this repo's spec killed all
// authenticated /admin/* HTTP surface (§13.5/§14.1) so this stays a
// local ops script rather than an admin route, matching I.3's own
// precedent. CF_TOKEN sourced the same way (env var, falling back to
// .env.local at the repo root).
//
// This script has no D1 dependency at all (unlike backfill-embeddings.mjs)
// -- its only inputs are the local seed JSON file and Workers AI/Vectorize.
//
// Safe to re-run: VECTORIZE.upsert overwrites cleanly by vector ID
// (confirmed idempotent, same citation as I.2/I.3), and this script's
// vector IDs are deterministic (`centroid:<roleCategory>`), so re-running
// after editing category-centroid-seeds.json simply replaces the 10
// centroid vectors with freshly computed ones.
//
// Usage:
//   CF_TOKEN=xxx node infrastructure/scripts/build-category-centroids.mjs
//   CF_TOKEN=xxx node infrastructure/scripts/build-category-centroids.mjs --dry-run

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CF_ACCOUNT_ID = "c62f54368e3f6a1f503afa434771b7e4"; // apps/api/wrangler.toml's account_id, same constant backfill-embeddings.mjs uses
const VECTORIZE_INDEX = "hiring-signals-jobs"; // apps/api/wrangler.toml's [[vectorize]] index_name -- reused, not a new index (I.5a)
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // apps/api/wrangler.toml's [vars].EMBEDDING_MODEL
const CENTROID_KIND = "category_centroid"; // metadata tag distinguishing centroid vectors from real job vectors

// Same inline .env.local parser backfill-embeddings.mjs uses -- kept
// duplicated rather than extracted to a shared lib for one four-line
// function, matching this directory's existing "small scripts, no
// shared-internals module yet" pattern (see companies-repo.ts's own
// isUniqueConstraintError note in ROADMAP.md for the same call made
// elsewhere in this repo).
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
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function loadSeeds() {
  const seedPath = path.join(REPO_ROOT, "infrastructure/scripts/category-centroid-seeds.json");
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const { _comment, ...categories } = raw;
  return categories;
}

/**
 * Same Workers AI REST call as backfill-embeddings.mjs's embedTexts --
 * duplicated rather than imported (plain Node .mjs, no shared-internals
 * module between ops scripts yet, same call made throughout this
 * directory). See that file's own header comment for the REST-shape
 * citation against Cloudflare's bge-base-en-v1.5 docs.
 */
async function embedTexts(texts, { cfToken }) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: texts }),
      signal: AbortSignal.timeout(60_000),
    },
  );
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

/** Same Vectorize v2 NDJSON upsert as backfill-embeddings.mjs -- see that file for the REST-shape citation. */
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
 * Mean-pools a list of equal-length embedding vectors into one vector,
 * then L2-normalizes the result -- bge-base-en-v1.5's own vectors are
 * unit-length (cosine metric, per I.1's index config), and a plain mean
 * of unit vectors is not itself unit-length, so re-normalizing keeps the
 * centroid comparable via cosine similarity the same way any other
 * vector in this index is (I.5b's nudge function assumes this).
 */
function meanPool(vectors) {
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  const mean = sum.map((x) => x / vectors.length);
  const norm = Math.sqrt(mean.reduce((acc, x) => acc + x * x, 0));
  return norm > 0 ? mean.map((x) => x / norm) : mean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envLocal = loadEnvLocal();
  const cfToken = process.env.CF_TOKEN || envLocal.CF_TOKEN || "";

  if (!cfToken) {
    console.error("Missing CF_TOKEN. Set it in the environment or in .env.local at the repo root.");
    console.error("See .env.local.example for the token permissions required.");
    process.exitCode = 1;
    return;
  }

  const seedsByCategory = loadSeeds();
  const categories = Object.keys(seedsByCategory);

  console.log(`\nbuild-category-centroids`);
  console.log(`  Vectorize index: ${VECTORIZE_INDEX} (existing, reused -- I.5a)`);
  console.log(`  categories: ${categories.length}`);
  console.log(`  mode: ${args.dryRun ? "dry-run (embed only, no upsert)" : "embed + upsert"}\n`);

  const vectors = [];
  for (const category of categories) {
    const phrases = seedsByCategory[category];
    if (!phrases || phrases.length === 0) {
      console.error(`  ${category}: no seed phrases, skipping`);
      continue;
    }
    const embedResult = await embedTexts(phrases, { cfToken });
    if (!embedResult.data || embedResult.data.length !== phrases.length) {
      throw new Error(
        `Embedding count mismatch for ${category}: sent ${phrases.length} phrases, got ${embedResult.data?.length ?? 0} back`,
      );
    }
    const centroid = meanPool(embedResult.data);
    console.log(`  ${category}: ${phrases.length} seeds -> centroid (dim ${centroid.length})`);
    vectors.push({
      id: `centroid:${category}`,
      values: centroid,
      metadata: { kind: CENTROID_KIND, roleCategory: category, seedCount: phrases.length },
    });
  }

  if (args.dryRun) {
    console.log(`\nDry run -- computed ${vectors.length} centroids, no upsert performed.`);
    return;
  }

  await upsertVectors(vectors, { cfToken });
  console.log(`\nDone -- upserted ${vectors.length} centroid vectors (kind: "${CENTROID_KIND}").`);
  console.log(
    "Re-run this script any time category-centroid-seeds.json changes -- upsert overwrites by vector ID.",
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
