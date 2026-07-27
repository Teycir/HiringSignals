-- Migration 0002: signal_evidence + jobs indexes for signals list filters
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote
--
-- GET /api/v1/signals filters on locationMode/country/source each run a
-- correlated EXISTS subquery against signal_evidence (see
-- packages/db/src/signals-repo.ts). Without indexes on the join columns
-- those subqueries fall back to full table scans of signal_evidence for
-- every candidate signal row -- O(N*M) instead of O(log M) lookups.

CREATE INDEX idx_signal_evidence_signal ON signal_evidence(signal_id);
CREATE INDEX idx_signal_evidence_job ON signal_evidence(job_id);

-- The same EXISTS subqueries also filter jobs by status/location_mode/
-- country_code once joined via signal_evidence.job_id.
CREATE INDEX idx_jobs_location ON jobs(status, location_mode, country_code);
