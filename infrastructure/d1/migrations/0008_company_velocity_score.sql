-- Migration 0008: hiring velocity score columns on companies (Q.1)
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote
--
-- ROADMAP.md Milestone Q.1's own text suggested numbering this
-- "0005_company_velocity_score.sql" -- 0005 was already taken by
-- 0005_signals_dedup_index.sql (2026-08-06) by the time Q.1 was
-- actually implemented, so this lands as 0008, the next free number
-- after 0007_trends_role_first_seen_index.sql (Milestone P.2).
--
-- computeHiringVelocity (packages/domain/src/hiring-velocity.ts, Q.1)
-- needs somewhere to persist its result so Q.3's trends/companies API
-- responses can read a precomputed score instead of recomputing it on
-- every request. All three columns default NULL: a company with no
-- velocity computed yet (before Q.2's reconciliation pass first runs
-- for it) has no score to report, not a fabricated 0 -- same "null
-- means not-yet-computed, 0 means computed-and-genuinely-zero"
-- distinction signals.score_version already relies on via score_version
-- being NOT NULL only once a real score exists.
ALTER TABLE companies ADD COLUMN hiring_velocity_score INTEGER;
ALTER TABLE companies ADD COLUMN velocity_score_version TEXT;
ALTER TABLE companies ADD COLUMN velocity_computed_at TEXT;
