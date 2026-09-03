-- Migration 0011: generic snapshot store (signals/trends D1-quota
-- resilience -- see snapshot-persistence-plan.md at the repo root).
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote
--
-- Replaces the KV "last known good" cache/fallback pattern (trends.ts,
-- facets.ts) with durable D1 storage, decoupled from request traffic
-- entirely. Two generic tables, shared by every domain (signals, trends,
-- and any future consumer) via a (domain, entity_key) composite key --
-- not one bespoke table per domain. See snapshot-persistence-plan.md
-- §3/§4 for the full design.
--
-- snapshots_current: one row per (domain, entity_key), overwritten in
-- place on each successful capture (the daily reconciliation cron, never
-- request traffic). Read path queries ONLY this table -- never the raw
-- jobs/companies/signals tables -- so a read request can never itself
-- consume the D1 read-quota budget that made the live query flaky.
--
-- snapshots_history: append-only, one row per successful capture, never
-- updated or deleted by application code. Because snapshots_current is
-- only ever overwritten (not read-modify-copied), "N-1" falls out for
-- free: the row that WAS current is already sitting in this table from
-- its own prior write, so writeSnapshot() only ever needs to (1) insert
-- here, then (2) upsert snapshots_current -- no copy-out step.
--
-- If a capture run fails or doesn't happen, snapshots_current is simply
-- not touched -- readers keep getting the last successful payload
-- indefinitely. No TTL, no expiry, no "stale" flag: staleness isn't an
-- error state here, it's the intended degrade path.

CREATE TABLE snapshots_current (
  domain TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (domain, entity_key)
);

CREATE TABLE snapshots_history (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

-- Read path for "N-1 / recent history for this key", most-recent-first.
-- No index needed on snapshots_current beyond its own PRIMARY KEY
-- (domain, entity_key) -- every read is a direct point lookup.
CREATE INDEX idx_snapshots_history_lookup
  ON snapshots_history(domain, entity_key, captured_at DESC);
