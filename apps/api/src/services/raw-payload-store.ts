import type { KVNamespace } from "@cloudflare/workers-types";
import { makeTtlStore, type TtlStore } from "../../../../lib/kv/ttl-store";

/**
 * Raw source-response archive, backed by its own **dedicated**
 * `RAW_PAYLOADS` KV namespace (not shared with CACHE). Originally lived in
 * the shared CACHE namespace (spec 8.1/8.2 originally specified R2;
 * switched to KV-only so the project doesn't require a Cloudflare account
 * with billing/a credit card attached -- R2 is the one binding that isn't
 * usable on the free tier without one).
 *
 * Split into a dedicated namespace per 2026-07-30 security review finding
 * CWE-668: raw ATS board payloads may contain internal contact info,
 * salary bands, requisition notes etc.; keeping them in their own KV
 * namespace means IAM can restrict reads to a small ops-only group, and a
 * future cache-debug endpoint on the CACHE namespace cannot echo raw
 * board data by accident.
 *
 * Retention matches spec 8.3 ("raw payloads retained 30 days, then
 * lifecycle-delete"): KV's native `expirationTtl` enforces this per-key,
 * so no separate cleanup job is needed the way R2 lifecycle rules would
 * require.
 *
 * Implementation is a thin wrapper around the generic TtlStore in
 * ../../../../lib/kv/ttl-store -- the only project-specific pieces are the
 * key prefix, retention window, and semantic wrappers (sourceId/runId
 * instead of raw string parts).
 */
const RAW_PAYLOAD_KEY_PREFIX = "raw:";
const RAW_PAYLOAD_RETENTION_SECONDS = 30 * 24 * 60 * 60; // spec 8.3: 30 days

/** Creates a TtlStore bound to the raw-payload prefix + retention window. */
export function makeRawPayloadStore(namespace: KVNamespace): TtlStore {
  return makeTtlStore(namespace, {
    keyPrefix: RAW_PAYLOAD_KEY_PREFIX,
    retentionSeconds: RAW_PAYLOAD_RETENTION_SECONDS,
  });
}

/**
 * Deterministic per-(source, run) key so a retried ingest run overwrites
 * rather than duplicates -- matches the idempotency requirement on
 * handleIngestMessage (spec 13.3, see jobs/ingest-consumer.ts).
 */
export function rawPayloadKey(sourceId: string, runId: string): string {
  return `${RAW_PAYLOAD_KEY_PREFIX}${sourceId}:${runId}`;
}

/**
 * Archives one raw ATS response body. Stored as opaque text (the caller
 * decides whether that's raw JSON text or a pre-serialized structure) so
 * this module stays provider-agnostic.
 */
export async function storeRawPayload(
  cache: KVNamespace,
  sourceId: string,
  runId: string,
  rawBody: string,
): Promise<string> {
  return makeRawPayloadStore(cache).put([sourceId, runId], rawBody);
}

/** Returns null if the payload was never stored or has already expired. */
export async function getRawPayload(cache: KVNamespace, key: string): Promise<string | null> {
  return makeRawPayloadStore(cache).get(key);
}
