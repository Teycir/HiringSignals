/**
 * Real `AI`, `VECTORIZE`, and KV bindings for tests -- per AGENTS.md's
 * "zero mocks, zero fakes" policy, same reasoning as live-d1-client.ts
 * in this package. There is no way to construct a live
 * `Ai`/`VectorizeIndex`/`KVNamespace` binding outside a deployed Worker,
 * so each of these shells out to a real Cloudflare-facing CLI:
 *
 * Token resolution (`loadCfToken` below) delegates to
 * `d1-remote-transport.ts`'s `requireCfToken` -- unified 2026-08-06
 * (test-support follow-up, ROADMAP.md Milestone J) so this file and
 * the D1 transport share exactly one CF_TOKEN/CLOUDFLARE_API_TOKEN/
 * `.env.local` resolution implementation instead of two that could
 * silently drift apart.
 *
 * - AI + VECTORIZE: `wrangler`'s dev/remote HTTP surface isn't scriptable
 *   for a one-off run() the way D1/KV are, so these two go through the
 *   same direct REST calls infrastructure/scripts/backfill-embeddings.mjs
 *   already established (Authorization: Bearer CF_TOKEN from
 *   .env.local, deliberately scoped to Workers AI: Edit + Vectorize:
 *   Edit only -- see .env.local's own header comment for why).
 * - KV: unlike AI/Vectorize, `wrangler kv key put/get/delete` IS a real
 *   scriptable CLI surface (confirmed via `wrangler kv key --help`,
 *   2026-07-30). Originally piggybacked on wrangler's own interactive
 *   login rather than widening CF_TOKEN's scope -- revised 2026-08-06
 *   after that stored login expired in a non-interactive environment
 *   with no way to re-run the browser-based `wrangler login` flow.
 *   CF_TOKEN's scope now includes KV:Edit (see .env.local's header) and
 *   runWrangler() passes it through as CLOUDFLARE_API_TOKEN, same as
 *   d1-remote-transport.ts already does for `wrangler d1`.
 *
 * Lives in `@hiring-signals/test-support` (a real workspace package),
 * not inside `apps/api/test/lib/` where it originated (2026-07-30) --
 * same reasoning as live-d1-client.ts's header comment: `packages/db`
 * needs this too, and neither `apps/api` (wrong dependency direction)
 * nor repo-root `lib/` (documented project-agnostic, zero
 * `@hiring-signals/*` imports) is the right home.
 *
 * Node-version note: same as live-d1-client.ts -- run under
 * `nvm use 24.18.0`, wrangler requires >=22.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Ai, VectorizeIndex, VectorizeMatches, VectorizeVector, KVNamespace } from "@cloudflare/workers-types";
import { requireCfToken } from "./d1-remote-transport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/test-support/src -> repo root -> apps/api. Same "exactly one
// wrangler.toml in the repo" reasoning as live-d1-client.ts's API_DIR.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const API_DIR = path.join(REPO_ROOT, "apps/api");

const CF_ACCOUNT_ID = "c62f54368e3f6a1f503afa434771b7e4"; // wrangler.toml's account_id
// wrangler.toml's three KV namespace ids (CACHE/RAW_PAYLOADS/ABUSE_LOGS)
// -- kept as a lookup table, not one hardcoded constant, so
// createLiveKvNamespace can serve any of the three bindings, not just
// CACHE (2026-07-30 generalization; see ROADMAP.md Milestone J).
const KV_NAMESPACE_IDS = {
  CACHE: "eed9bc4587124ff8b55ee274a0a2c66e",
  RAW_PAYLOADS: "ca20113fb0cf427f87310007f96f2cb5",
  ABUSE_LOGS: "4222eb727bff4cec8aee8b2442f71a13",
} as const;
export type LiveKvBinding = keyof typeof KV_NAMESPACE_IDS;

/**
 * Reads a Cloudflare API token from the environment or `.env.local`,
 * throwing immediately if none is found. Re-exported name kept as
 * `loadCfToken` for this file's own existing call sites below and for
 * any external caller already importing it from this module -- the
 * actual resolution logic now lives once, in
 * `d1-remote-transport.ts`'s `requireCfToken` (test-support follow-up,
 * ROADMAP.md Milestone J: this file's version previously only matched
 * a bare `CF_TOKEN=` line and never recognized `CLOUDFLARE_API_TOKEN`,
 * while d1-remote-transport.ts's version already handled both --
 * unifying here is strictly more permissive than before, not a
 * behavior narrowing, and removes the risk of the two copies drifting
 * further apart).
 */
function loadCfToken(): string {
  return requireCfToken();
}

/** Runs one `wrangler` subcommand against the API app's directory (where
 * wrangler.toml's bindings live), rejecting with real stderr/stdout on
 * failure -- same discipline as live-d1-client.ts's execRemote.
 *
 * Passes CLOUDFLARE_API_TOKEN (derived from CF_TOKEN via loadCfToken())
 * into the spawned process's env -- this file's own header comment
 * originally chose to rely on wrangler's stored interactive login
 * instead of CF_TOKEN for the KV surface specifically, but a stored
 * login can silently expire and its refresh flow needs an interactive
 * terminal, which CI/agent environments don't have. CF_TOKEN must be
 * scoped to include KV:Edit for this to work (see .env.local's header
 * comment on this token's scope) -- same env-injection pattern
 * d1-remote-transport.ts already uses for its own wrangler d1 calls. */
function runWrangler(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: API_DIR,
      shell: false,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: loadCfToken() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn wrangler: ${err.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Real `KVNamespace` backed by one of the three live, remote KV
 * namespaces (`CACHE`/`RAW_PAYLOADS`/`ABUSE_LOGS`, see wrangler.toml)
 * via `wrangler kv key put/get/delete --namespace-id ... --remote`.
 * Defaults to `CACHE` (this function's original single-namespace
 * behavior, before the 2026-07-30 generalization) so existing call
 * sites written as `createLiveKvNamespace()` keep working unchanged.
 * Only implements the three methods ttl-store.ts's makeTtlStore
 * actually calls (get with "text" type, put with expirationTtl,
 * delete) -- narrower than the full KVNamespace interface on purpose,
 * cast to it below since that's all any current caller needs.
 *
 * get() on a missing key: confirmed live (2026-07-30) that `wrangler kv
 * key get` on a nonexistent key exits non-zero with a 404 from
 * Cloudflare's API, not an empty success -- translated to `null` below
 * to match KVNamespace.get's own documented behavior for a missing key.
 */
export function createLiveKvNamespace(binding: LiveKvBinding = "CACHE"): KVNamespace {
  const namespaceId = KV_NAMESPACE_IDS[binding];
  return {
    async get(key: string, _type?: unknown): Promise<string | null> {
      const { code, stdout, stderr } = await runWrangler([
        "kv",
        "key",
        "get",
        key,
        "--namespace-id",
        namespaceId,
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
      const args = ["kv", "key", "put", key, value, "--namespace-id", namespaceId, "--remote"];
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
        namespaceId,
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

    /**
     * Real delete-by-id, added for test cleanup (ingest-consumer.test.ts,
     * ROADMAP.md Milestone J's ingest-consumer migration item -- that
     * file's own tests write real vectors via embedAndUpsertJob and need
     * a real way to remove them afterward, same reasoning as query/upsert
     * above: no wrangler CLI surface for Vectorize, so this goes through
     * the same v2 REST API directly). Cloudflare's Vectorize v2
     * delete-by-ids endpoint is confirmed (2026-07-30 docs) to accept a
     * JSON body `{ ids: string[] }` and return the deleted count/ids
     * under the same `{ success, result }` envelope as query/upsert.
     */
    async deleteByIds(ids: string[]) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${indexName}/delete_by_ids`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Vectorize deleteByIds failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown; result: unknown };
      if (!json.success) {
        throw new Error(`Vectorize deleteByIds failed: ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.result;
    },
  } as unknown as VectorizeIndex;
}
