-- Migration 0005: composite dedup index for findActiveSignal
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote
--
-- findActiveSignal (packages/db/src/signals-write-repo.ts) is the dedup
-- check run on every ingestion event, filtering on
-- (company_id, role_category, signal_type, status). idx_signals_feed
-- (migration 0001) covers (status, role_category, score DESC,
-- last_detected_at DESC) -- no leading company_id, so this query forces
-- a scan of every 'active' row for the matching role_category. As the
-- signals table grows this becomes O(N) per ingestion event instead of
-- an index lookup.

CREATE INDEX idx_signals_dedup
  ON signals(company_id, role_category, signal_type, status);
