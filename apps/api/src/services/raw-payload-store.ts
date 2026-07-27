import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Raw source-response archive, backed by the shared CACHE KV namespace
 * instead of R2 (spec 8.1/8.2 originally specified R2; switched to
 * KV-only so the project doesn't require a Cloudflare account with
 * billing/a credit card attached -- R2 is the one binding that isn't
 * usable on the free tier without one).
 *
 * Retention matches spec 8.3 ("raw payloads retained 30 days, then
 * lifecycle-delete"): KV's native `expirationTtl` enforces this per-key,
 * so no separate cleanup job is needed the way R2 lifecycle rules would
 * require.
 *
 * Caveat vs R2: KV values are capped at 25MB and are eventually
 * consistent, not strongly consistent -- both acceptable here since raw
 * ATS job-board responses are well under 25MB and this data is
 * diagnostic/audit-only, never read on the hot path.
 */

const RAW_PAYLOAD_KEY_PREFIX = "raw:";
const RAW_PAYLOAD_RETENTION_SECONDS = 30 * 24 * 60 * 60; // spec 8.3: 30 days

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
  const key = rawPayloadKey(sourceId, runId);
  await cache.put(key, rawBody, { expirationTtl: RAW_PAYLOAD_RETENTION_SECONDS });
  return key;
}

/** Returns null if the payload was never stored or has already expired. */
export async function getRawPayload(cache: KVNamespace, key: string): Promise<string | null> {
  return cache.get(key, "text");
}
