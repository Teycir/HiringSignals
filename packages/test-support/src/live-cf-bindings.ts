/**
 * Real `AI`, `VECTORIZE`, and KV bindings for tests -- per AGENTS.md's
 * "zero mocks, zero fakes" policy, same reasoning as live-d1-client.ts
 * in this package. There is no way to construct a live
 * `Ai`/`VectorizeIndex`/`KVNamespace` binding outside a deployed Worker.
 * All three now go through direct Cloudflare REST calls (see below) --
 * KV was the last holdout still shelling out to `wrangler`, until the
 * 2026-08-08 revision documented below.
 *
 * Token resolution (`loadCfToken` below) delegates to
 * `d1-remote-transport.ts`'s `requireCfToken` -- unified 2026-08-06
 * (test-support follow-up, ROADMAP.md Milestone J) so this file and
 * the D1 transport share exactly one CF_TOKEN/CLOUDFLARE_API_TOKEN/
 * `.env.local` resolution implementation instead of two that could
 * silently drift apart.
 *
 * - AI + VECTORIZE: `wrangler`'s dev/remote HTTP surface isn't scriptable
 *   for a one-off run() the way D1 is, so these two go through the
 *   same direct REST calls infrastructure/scripts/backfill-embeddings.mjs
 *   already established (Authorization: Bearer CF_TOKEN from
 *   .env.local, deliberately scoped to Workers AI: Edit + Vectorize:
 *   Edit only -- see .env.local's own header comment for why).
 * - KV: originally shelled out to `wrangler kv key put/get/delete
 *   --remote` (confirmed a real scriptable CLI surface, 2026-07-30) via
 *   CF_TOKEN passed through as CLOUDFLARE_API_TOKEN -- revised
 *   2026-08-08 after `admin-auth.test.ts`'s live-KV integration tests
 *   were found to take 13-14s *per KV call* (measured live, this
 *   machine: `wrangler --version` alone costs ~7s of real CPU time to
 *   boot regardless of npx/local-binary/monorepo-vs-empty-dir, i.e. an
 *   inherent wrangler-CLI-startup cost, not a cache-miss or network
 *   issue -- confirmed by isolating each variable independently). KV
 *   has the same direct-REST surface AI/Vectorize already use below
 *   (confirmed live against the real ABUSE_LOGS namespace, 2026-08-08:
 *   GET/PUT/DELETE each ~0.3-0.6s, a ~25x improvement over the wrangler
 *   subprocess path), so KV now matches AI/Vectorize's approach instead
 *   of being the one exception -- same CF_TOKEN, same Bearer-auth
 *   pattern, no separate credential or scope needed (KV:Edit was
 *   already added to CF_TOKEN's scope 2026-08-06 for the old wrangler
 *   path; see .env.local's header).
 *
 * Lives in `@hiring-signals/test-support` (a real workspace package),
 * not inside `apps/api/test/lib/` where it originated (2026-07-30) --
 * same reasoning as live-d1-client.ts's header comment: `packages/db`
 * needs this too, and neither `apps/api` (wrong dependency direction)
 * nor repo-root `lib/` (documented project-agnostic, zero
 * `@hiring-signals/*` imports) is the right home.
 *
 * Node-version note: this file itself no longer needs a wrangler-
 * compatible Node version (KV/AI/Vectorize are all now plain `fetch`
 * calls) -- the >=22 requirement only still applies if the *caller*
 * also pulls in d1-remote-transport.ts's `execRemote` for live D1.
 */
import type { Ai, VectorizeIndex, VectorizeMatches, VectorizeVector, KVNamespace } from "@cloudflare/workers-types";
import { requireCfToken } from "./d1-remote-transport";

// No filesystem/subprocess machinery needed in this file anymore -- KV,
// AI, and Vectorize are all plain `fetch` calls against Cloudflare's
// REST API now (see header comment). d1-remote-transport.ts still owns
// its own REPO_ROOT/API_DIR resolution for `wrangler d1`, unrelated to
// this file.
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

/**
 * Real `KVNamespace` backed by one of the three live, remote KV
 * namespaces (`CACHE`/`RAW_PAYLOADS`/`ABUSE_LOGS`, see wrangler.toml)
 * via Cloudflare's direct KV REST API (`GET`/`PUT`/`DELETE
 * .../values/{key}`) -- same Bearer-auth-via-CF_TOKEN pattern as
 * createLiveAiBinding/createLiveVectorizeIndex below, not a wrangler
 * subprocess (see this file's header comment for why: a `wrangler kv`
 * subprocess was measured live at 13-14s per call, vs ~0.3-0.6s for
 * the equivalent REST call, confirmed 2026-08-08 against this same
 * ABUSE_LOGS namespace). Defaults to `CACHE` (this function's original
 * single-namespace behavior, before the 2026-07-30 generalization) so
 * existing call sites written as `createLiveKvNamespace()` keep
 * working unchanged. Only implements the three methods
 * ttl-store.ts's makeTtlStore actually calls (get with "text" type,
 * put with expirationTtl, delete) -- narrower than the full
 * KVNamespace interface on purpose, cast to it below since that's all
 * any current caller needs.
 *
 * get() on a missing key: confirmed live (2026-08-08) that the REST
 * `GET .../values/{key}` endpoint returns HTTP 404 with a JSON error
 * envelope (`{ success: false, errors: [{ code: 10009, message: "get:
 * 'key not found'" }] }`) for a nonexistent key, not an empty 200 --
 * translated to `null` below to match KVNamespace.get's own documented
 * behavior for a missing key.
 */
export function createLiveKvNamespace(binding: LiveKvBinding = "CACHE"): KVNamespace {
  const namespaceId = KV_NAMESPACE_IDS[binding];
  const cfToken = loadCfToken();
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values`;

  return {
    async get(key: string, _type?: unknown): Promise<string | null> {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${cfToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`KV get failed: HTTP ${res.status}: ${body.slice(0, 300)}\nkey: ${key}`);
      }
      // Unlike AI/Vectorize's JSON envelope, a successful KV value GET
      // returns the raw stored value as the response body directly (no
      // { success, result } wrapper) -- confirmed live 2026-08-08.
      return await res.text();
    },

    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const url = new URL(`${baseUrl}/${encodeURIComponent(key)}`);
      if (options?.expirationTtl) url.searchParams.set("expiration_ttl", String(options.expirationTtl));
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${cfToken}` },
        body: value,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`KV put failed: HTTP ${res.status}: ${body.slice(0, 300)}\nkey: ${key}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown };
      if (!json.success) {
        throw new Error(`KV put failed: ${JSON.stringify(json.errors)}\nkey: ${key}`);
      }
    },

    async delete(key: string): Promise<void> {
      // Confirmed live (2026-08-08): DELETE on an already-absent key
      // still returns HTTP 200 with success:true (KV delete is
      // idempotent by design, unlike get which 404s on a miss) -- so
      // no "was it already gone" branch is needed here, any non-2xx
      // response is a real failure.
      const res = await fetch(`${baseUrl}/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`KV delete failed: HTTP ${res.status}: ${body.slice(0, 300)}\nkey: ${key}`);
      }
      const json = (await res.json()) as { success: boolean; errors?: unknown };
      if (!json.success) {
        throw new Error(`KV delete failed: ${JSON.stringify(json.errors)}\nkey: ${key}`);
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
