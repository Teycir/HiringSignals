/**
 * KV-backed audit + abuse-signal logger.
 *
 * Inspired by Timeseal's auditLogger.ts. Stores are append-only and
 * partitioned by (day, eventType) so the abuse dashboard can do cheap
 * counts via a single `kv.list({ prefix })` per bucket. Retention is
 * enforced via KV TTL on every entry; no separate sweep job.
 *
 * Zero project-specific dependencies. No Hono types required.
 */

import type { KVNamespace } from "@cloudflare/workers-types";

export enum AbuseEventType {
  RATE_LIMIT_HIT = "RATE_LIMIT_HIT",
  CAPTCHA_FAILED = "CAPTCHA_FAILED",
  CAPTCHA_MISSING = "CAPTCHA_MISSING",
  ADMIN_WRITE_UNVERIFIED = "ADMIN_WRITE_UNVERIFIED",
  MALFORMED_INPUT = "MALFORMED_INPUT",
  UNEXPECTED_ERROR = "UNEXPECTED_ERROR",
  BULKHEAD_REJECTED = "BULKHEAD_REJECTED",
  CIRCUIT_OPEN = "CIRCUIT_OPEN",
  AUDIT_SIGNAL_READ = "AUDIT_SIGNAL_READ",
  AUDIT_SIGNAL_WRITE = "AUDIT_SIGNAL_WRITE",
}

export interface AbuseEvent {
  ts: number;
  type: AbuseEventType;
  ip: string;
  /** Route/resource identifier, e.g. "GET /api/v1/signals". */
  route: string;
  /** Short freeform reason, e.g. "429 - limit 600/5m". */
  detail?: string;
  /** Optional structured metadata. Kept small — KV values are unbounded, but this store is meant for counts, not payload capture. */
  meta?: Record<string, string | number | boolean>;
}

export interface AuditAbuseConfig {
  kv: KVNamespace;
  /** Key prefix, e.g. "abuse:" — defaults to "ab:". */
  prefix?: string;
  /** How long each event is retained in KV. Default 14 days. */
  retentionSeconds?: number;
}

const DEFAULT_RETENTION_S = 14 * 24 * 60 * 60;

function uuidLike(): string {
  // crypto.randomUUID() on Cloudflare Workers and Node 19+; falls back to
  // timestamp + high-entropy random suffix in environments that don't expose
  // the WebCrypto UUID helper (keeps event keys collision-free).
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * KV key: <prefix><day>:<type>:<uuid>
 *
 * Design: prefix:day:type groups events for a single dashboard query via
 * `kv.list({ prefix: "ab:2026-07-27:RATE_LIMIT_HIT:" })`, then the uuid
 * suffix keeps concurrent writes unique (no clobbering). The IP is stored
 * *inside* the JSON value, not in the key — so querying "all events by
 * IP X today" is expensive, but querying counts for the abuse-dashboard
 * panels (the primary use case today) is one kv.list + .length per type.
 */
function makeKey(cfg: AuditAbuseConfig, ev: AbuseEvent): string {
  const prefix = cfg.prefix ?? "ab:";
  const day = new Date(ev.ts).toISOString().slice(0, 10); // YYYY-MM-DD
  return `${prefix}${day}:${ev.type}:${uuidLike()}`;
}

export async function recordAbuseEvent(
  cfg: AuditAbuseConfig,
  ev: AbuseEvent,
): Promise<void> {
  const key = makeKey(cfg, ev);
  const body = JSON.stringify(ev);
  const ttl = cfg.retentionSeconds ?? DEFAULT_RETENTION_S;
  try {
    await cfg.kv.put(key, body, { expirationTtl: ttl });
  } catch {
    // never let an audit-log failure break the user-visible response
  }
}
