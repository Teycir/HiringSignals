/**
 * Generic TTL-keyed blob store over a Cloudflare Workers KV namespace.
 * Useful anywhere you'd reach for an object store (R2, S3) purely to hold
 * data with a retention window -- KV's native `expirationTtl` enforces
 * that per-key, so no separate cleanup job is needed. R2/S3 also require
 * billing set up on the account; KV does not, so this is a good default
 * for early-stage projects that want retention semantics without that
 * requirement.
 *
 * Caveat vs an object store: KV values are capped at 25MB and are
 * eventually consistent, not strongly consistent. Fine for
 * diagnostic/audit/cache data that's never read on a hot,
 * consistency-sensitive path; not a replacement for R2/S3 if you need
 * either larger blobs or read-your-writes guarantees.
 *
 * Zero project-specific dependencies -- copy this file into any
 * Cloudflare Workers + KV project as-is. Give it your own key prefix and
 * TTL per use case (see makeTtlStore).
 */

import type { KVNamespace } from "@cloudflare/workers-types";

export interface TtlStore {
  /** Builds the deterministic key for a given set of key parts. */
  key(...parts: string[]): string;
  /** Stores a value under the given key parts, applying the configured TTL. */
  put(parts: string[], value: string): Promise<string>;
  /** Returns null if the value was never stored or has already expired. */
  get(key: string): Promise<string | null>;
  /** Deletes a value before its TTL expires, if needed. */
  delete(key: string): Promise<void>;
}

export interface TtlStoreOptions {
  /** Prepended to every key, e.g. "raw:" or "session:". Include your own separator. */
  keyPrefix: string;
  /** How long a stored value survives before KV expires it automatically. */
  retentionSeconds: number;
  /** Key-part separator. Defaults to ":". */
  separator?: string;
}

/**
 * Creates a TtlStore bound to one KV namespace, prefix, and retention
 * window. Call this once per logical use case (e.g. one for raw payload
 * archival, a separate one for rate-limit counters) rather than sharing
 * a single instance across unrelated data with different retention needs.
 */
export function makeTtlStore(namespace: KVNamespace, options: TtlStoreOptions): TtlStore {
  const separator = options.separator ?? ":";

  function key(...parts: string[]): string {
    return `${options.keyPrefix}${parts.join(separator)}`;
  }

  return {
    key,

    async put(parts: string[], value: string): Promise<string> {
      const k = key(...parts);
      await namespace.put(k, value, { expirationTtl: options.retentionSeconds });
      return k;
    },

    async get(key: string): Promise<string | null> {
      return namespace.get(key, "text");
    },

    async delete(key: string): Promise<void> {
      await namespace.delete(key);
    },
  };
}
