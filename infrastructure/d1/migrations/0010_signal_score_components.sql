-- Migration 0010: persist score components alongside the final score
-- (ROADMAP.md V.3, spec §7.2 / §10.5).
--
-- The spec requires that "a user should be able to answer 'why is this
-- ranked 82?' from the detail screen." The five component columns
-- (freshness / volume / acceleration / breadth / confidence) are computed
-- by computeNewJobScore / computeReconciliationScore at write time
-- (packages/domain/src/signal-score.ts) but were previously thrown away
-- after the final score was computed. This migration adds nullable columns
-- for them so new/refreshed rows persist them, while old rows stay null
-- (signals-repo.ts / score-breakdown.tsx degrade gracefully to the
-- existing generic formula description for null rows).
--
-- All five are REAL (0-1 fractional, matching ScoreComponents' own range
-- documentation) and nullable: existing rows have no component data, and
-- forcing NOT NULL would require a default value that would misrepresent
-- the actual historical computation.

ALTER TABLE signals ADD COLUMN score_freshness   REAL NULL;
ALTER TABLE signals ADD COLUMN score_volume       REAL NULL;
ALTER TABLE signals ADD COLUMN score_acceleration REAL NULL;
ALTER TABLE signals ADD COLUMN score_breadth      REAL NULL;
ALTER TABLE signals ADD COLUMN score_confidence   REAL NULL;
