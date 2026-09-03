/**
 * Generic KV-backed mirror of ../d1/snapshot-store.ts's "capture once,
 * serve indefinitely" snapshot store -- same (domain, entity_key)
 * composite key, same writeSnapshot/readSnapshot/readSnapshotsForDomain
 * shape, so callers on either store are interchangeable at the call
 * site (see snapshot-persistence-plan.md's KV-mirror follow-up,
 * 2026-09-03).
 *
 * Why this exists alongside d1/snapshot-store.ts, not instead of it:
 * snapshots_current/snapshots_history in D1 are still the primary,
 * queryable, historied store (see that file's own header comment for
 * why D1 -- not KV -- was chosen as the primary mechanism). But a D1
 * row is still a D1 read, and Cloudflare's free-tier D1 daily row-read
 * quota is account-wide, shared with every other D1 consumer (the
 * ingestion cron, reconciliation itself) -- so an account-wide quota
 * exhaustion can make even a tiny single-row snapshots_current lookup
 * throw, independent of that read's own cost. KV is a genuinely
 * separate resource with its own separate quota, so a value mirrored
 * here survives a D1 outage of any kind, not just a cheaper D1 query.
 *
 * This is deliberately NOT a cache: no TTL, no expiry, and it is never
 * the primary write target -- callers write here immediately alongside
 * (never instead of) their d1/snapshot-store.ts writeSnapshot() call,
 * same order both times, and always best-effort (a KV write failure
 * here must never fail the D1 write it accompanies). See each call
 * site's own comment for why.
 *
 * Zero project-specific imports -- copy this file wholesale into
 * another project, same convention as every other lib/ module (see
 * lib/README.md).
 */

import type { KVNamespace } from "@cloudflare/workers-types";

/** Deterministic KV key for a given (domain, entityKey) pair. Exported
 * so a caller needing the raw key directly (e.g. for a manual/ops
 * lookup) never has to hand-reconstruct this format. */
export function snapshotMirrorKey(domain: string, entityKey: string): string {
  return `snapshot_mirror:v1:${domain}:${entityKey}`;
}

interface SnapshotMirrorValue<T> {
  payload: T;
  capturedAt: string;
}

/**
 * Writes one snapshot mirror entry. Always best-effort: catches and
 * logs its own failure rather than throwing, since a KV write failure
 * (its own daily write-quota, or any other KV error) must never fail
 * the caller's real (D1) snapshot write or skip the rest of a capture
 * run over a mirror that is, by design, a secondary/best-effort copy.
 */
export async function writeSnapshotMirror<T>(
  namespace: KVNamespace,
  params: {
    domain: string;
    entityKey: string;
    payload: T;
    capturedAt: string;
  },
): Promise<void> {
  const key = snapshotMirrorKey(params.domain, params.entityKey);
  try {
    const value: SnapshotMirrorValue<T> = { payload: params.payload, capturedAt: params.capturedAt };
    await namespace.put(key, JSON.stringify(value));
  } catch (err) {
    console.error(`KV snapshot mirror write failed for key ${key}:`, err);
  }
}

/**
 * Reads one snapshot mirror entry. Returns null both when the key was
 * never written AND when the KV read itself fails -- callers treat
 * "nothing to fall back to" and "the fallback path is unreachable" the
 * same way (there is nothing further to fall back to from here), so
 * this never throws.
 */
export async function readSnapshotMirror<T>(
  namespace: KVNamespace,
  params: { domain: string; entityKey: string },
): Promise<{ payload: T; capturedAt: string } | null> {
  const key = snapshotMirrorKey(params.domain, params.entityKey);
  try {
    const raw = await namespace.get(key, "json");
    if (!raw) return null;
    return raw as SnapshotMirrorValue<T>;
  } catch (err) {
    console.error(`KV snapshot mirror read failed for key ${key}:`, err);
    return null;
  }
}

/**
 * Reads several snapshot mirror entries for a domain at once, keyed by
 * entity_key -- the shape a multi-key caller (e.g. trends.ts fanning
 * out over several requested role categories) needs. Unlike D1's
 * `WHERE entity_key IN (...)`, KV has no native multi-get, so this
 * issues one get() per requested key, in parallel. A per-key failure
 * (or missing key) is simply omitted from the result map rather than
 * failing the whole call -- same "never throws, absence just means
 * nothing to serve for that key" contract as readSnapshotMirror above.
 *
 * entityKeys is required here (unlike D1's readSnapshotsForDomain,
 * which can list an entire domain via a WHERE domain = ? scan) since KV
 * has no equivalent efficient "all keys under this domain" query
 * without a separate key-index structure this module deliberately
 * doesn't introduce -- callers needing "every entity_key" should get
 * that key list from their own domain constant (e.g. ROLE_CATEGORIES)
 * rather than from KV itself.
 */
export async function readSnapshotMirrorsForDomain<T>(
  namespace: KVNamespace,
  params: { domain: string; entityKeys: string[] },
): Promise<Map<string, { payload: T; capturedAt: string }>> {
  const result = new Map<string, { payload: T; capturedAt: string }>();

  const entries = await Promise.all(
    params.entityKeys.map(async (entityKey) => {
      const value = await readSnapshotMirror<T>(namespace, { domain: params.domain, entityKey });
      return [entityKey, value] as const;
    }),
  );

  for (const [entityKey, value] of entries) {
    if (value) result.set(entityKey, value);
  }
  return result;
}
