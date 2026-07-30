/**
 * Real `AI`, `VECTORIZE`, and `CACHE` (KV) bindings for tests -- per
 * AGENTS.md's "zero mocks, zero fakes" policy, same reasoning as
 * live-d1-client.ts in this directory. There is no way to construct a
 * live `Ai`/`VectorizeIndex`/`KVNamespace` binding outside a deployed
 * Worker, so each of these shells out to a real Cloudflare-facing CLI:
 *
 * - AI + VECTORIZE: `wrangler`'s dev/remote HTTP surface isn't scriptable
 *   for a one-off run() the way D1/KV are, so these two go through the
 *   same direct REST calls infrastructure/scripts/backfill-embeddings.mjs
 *   already established (Authorization: Bearer CF_TOKEN from
 *   .env.local, deliberately scoped to Workers AI: Edit + Vectorize:
 *   Edit only -- see .env.local's own header comment for why).
 * - CACHE (KV): unlike AI/Vectorize, `wrangler kv key put/get/delete`
 *   IS a real scriptable CLI surface (confirmed via `wrangler kv key
 *   --help`, 2026-07-30) -- so per the "use wrangler CLI for KV too,
 *   like D1" decision, this piggybacks on wrangler's own login instead
 *   of widening CF_TOKEN's scope to include KV, keeping that token
 *   exactly as narrowly scoped as .env.local's header documents.
 *
 * Node-version note: same as live-d1-client.ts -- run under
 * `nvm use 24.18.0`, wrangler requires >=22.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as fs from "node:fs";
import type { Ai, VectorizeIndex, VectorizeMatches, VectorizeVector, KVNamespace } from "@cloudflare/workers-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_DIR, "../..");

const CF_ACCOUNT_ID = "c62f54368e3f6a1f503afa434771b7e4"; // wrangler.toml's account_id
const KV_CACHE_NAMESPACE_ID = "eed9bc4587124ff8b55ee274a0a2c66e"; // wrangler.toml's CACHE binding id

/** Reads CF_TOKEN from .env.local if not already in the environment --
 * same inline parser backfill-embeddings.mjs uses. */
function loadCfToken(): string {
  if (process.env.CF_TOKEN) return process.env.CF_TOKEN;
  const envPath = path.join(REPO_ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^CF_TOKEN=(.*)$/);
      if (m?.[1]) return m[1].trim();
    }
  }
  throw new Error("Missing CF_TOKEN. Set it in the environment or in .env.local at the repo root.");
}

/** Runs one `wrangler` subcommand against the API app's directory (where
 * wrangler.toml's bindings live), rejecting with real stderr/stdout on
 * failure -- same discipline as live-d1-client.ts's execRemote. */
function runWrangler(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], { cwd: API_DIR, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn wrangler: ${err.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Real `KVNamespace` backed by the live, remote `CACHE` KV namespace via
 * `wrangler kv key put/get/delete --namespace-id ... --remote`. Only
 * implements the three methods ttl-store.ts's makeTtlStore actually
 * calls (get with "text" type, put with expirationTtl, delete) --
 * narrower than the full KVNamespace interface on purpose, cast to it
 * below since that's all any current caller needs.
 *
 * get() on a missing key: confirmed live (2026-07-30) that `wrangler kv
 * key get` on a nonexistent key exits non-zero with a 404 from
 * Cloudflare's API, not an empty success -- translated to `null` below
 * to match KVNamespace.get's own documented behavior for a missing key.
 */
export function createLiveKvNamespace(): KVNamespace {
  return {
    async get(key: string, _type?: unknown): Promise<string | null> {
      const { code, stdout, stderr } = await runWrangler([
        "kv",
        "key",
        "get",
        key,
        "--namespace-id",
        KV_CACHE_NAMESPACE_ID,
        "--remote",
        "--text",
      ]);
      if (code !== 0) {
        if (/404|not found/i.test(stderr) || /404|not found/i.test(stdout)) return null;
        throw new Error(`wrangler kv key get failed (exit ${code}):\n${stderr || stdout}\nkey: ${key}`);
      }
      // wrangler prints the raw value with a trailing newline; --text
      // mode has no other framing to strip.
      return stdout.replace(/\n$/, "");
    },

    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const args = ["kv", "key", "put", key, value, "--namespace-id", KV_CACHE_NAMESPACE_ID, "--remote"];
      if (options?.expirationTtl) args.push("--ttl", String(options.expirationTtl));
      const { code, stdout, stderr } = await runWrangler(args);
      if (code !== 0) {
        throw new Error(`wrangler kv key put failed (exit ${code}):\n${stderr || stdout}\nkey: ${key}`);
      }
    },

    async delete(key: string): Promise<void> {
      // Confirmed live (2026-07-30): `wrangler kv key delete` on an
      // already-absent key exits 0 (KV delete is idempotent by design,
      // unlike `get` which 404s on a miss) -- so no "was it already
      // gone" branch is needed here, any non-zero exit is a real failure.
      const { code, stdout, stderr } = await runWrangler([
        "kv",
        "key",
        "delete",
        key,
        "--namespace-id",
        KV_CACHE_NAMESPACE_ID,
        "--remote",
      ]);
      if (code !== 0) {
        throw new Error(`wrangler kv key delete failed (exit ${code}):\n${stderr || stdout}\nkey: ${key}`);
      }
    },
  } as unknown as KVNamespace;
}


/**
 * Real `Ai` binding backed by Workers AI's REST endpoint
 * (`POST .../ai/run/<model>`) -- same request/response shape
 * backfill-embeddings.mjs's embedTexts already uses and this project has
 * already run live against `@cf/baai/bge-base-en-v1.5`. Only implements
 * `run()`, the one method semantic-search.ts's getQueryEmbedding calls.
 */
export function createLiveAiBinding(): Ai {
  const cfToken = loadCfToken();
  return {
    async run(model: string, options: { text: string[] }) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: options.text }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Workers AI run failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown; result: unknown };
      if (!json.success) {
        throw new Error(`Workers AI run failed: ${JSON.stringify(json.errors ?? json)}`);
      }
      // Unwraps the REST envelope's `result` one level, same as
      // backfill-embeddings.mjs's embedTexts -- matches the shape
      // env.AI.run(...) returns directly inside a real Worker.
      return json.result;
    },
  } as unknown as Ai;
}

/**
 * Real `VectorizeIndex` backed by Vectorize's v2 REST endpoints (query +
 * upsert) -- upsert reuses backfill-embeddings.mjs's confirmed-working
 * NDJSON upsert shape; query uses the v2 query endpoint, confirmed
 * (2026-07-30, Cloudflare docs) to return `{ count, matches: [{ id,
 * score, ... }] }` under the REST envelope's `result` key -- the exact
 * `{ matches }` shape semantic-search.ts's findSemanticSignalMatches
 * already destructures. Only implements query() and upsert(), the two
 * methods this repo's app code + ops scripts actually call.
 */
export function createLiveVectorizeIndex(): VectorizeIndex {
  const cfToken = loadCfToken();
  const indexName = "hiring-signals-jobs"; // wrangler.toml's [[vectorize]] index_name

  return {
    async query(vector: number[], options?: { topK?: number; returnMetadata?: unknown; returnValues?: boolean }) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${indexName}/query`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            vector,
            topK: options?.topK,
            returnValues: options?.returnValues,
            // Vectorize's query endpoint takes 'none' | 'indexed' | 'all',
            // not a boolean -- normalize the app code's `false` to 'none'
            // here so this test client matches the real accepted enum
            // even though the app code itself passes a boolean.
            returnMetadata: options?.returnMetadata === false ? "none" : (options?.returnMetadata ?? "none"),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Vectorize query failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown; result: VectorizeMatches };
      if (!json.success) {
        throw new Error(`Vectorize query failed: ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.result;
    },

    async upsert(vectors: VectorizeVector[]) {
      const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${indexName}/upsert`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/x-ndjson" },
          body: ndjson,
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Vectorize upsert failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown; result: unknown };
      if (!json.success) {
        throw new Error(`Vectorize upsert failed: ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.result;
    },
  } as unknown as VectorizeIndex;
}
