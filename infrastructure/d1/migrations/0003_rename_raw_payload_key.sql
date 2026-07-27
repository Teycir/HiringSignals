-- Migration 0003: rename source_runs.raw_payload_r2_key -> raw_payload_key
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote
--
-- Raw source-response archival moved from R2 to the CACHE KV namespace
-- (see apps/api/src/services/raw-payload-store.ts) so the project doesn't
-- require Cloudflare billing/a credit card on the account. The column
-- name is renamed to stop implying an R2 object key -- it now holds the
-- KV key produced by rawPayloadKey(sourceId, runId), e.g.
-- "raw:{sourceId}:{runId}". Values already written under the old column
-- name are preserved: the KV key *format* is unchanged, only the SQL
-- column name and its meaning in comments/docs are updated.

ALTER TABLE source_runs RENAME COLUMN raw_payload_r2_key TO raw_payload_key;
