import type { RoleCategory, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";

/**
 * Write-path repo for `signals`/`signal_evidence` (ROADMAP.md Milestone
 * C, spec §7). Kept separate from the read-only signals-repo.ts -- that
 * file's query-building style (cursor pagination, EXISTS filters,
 * per-row degrade) is read-optimized and unrelated to the write
 * concerns here (dedup checks, single-row inserts). Mixing the two would
 * make signals-repo.ts harder to reason about for either purpose.
 */

export interface SignalRowMinimal {
  id: string;
  status: string;
  score: number;
  first_detected_at: string;
  last_detected_at: string;
}

export interface SignalReconciliationRow {
  id: string;
  company_id: string;
  role_category: RoleCategory;
  signal_type: SignalType;
  score: number;
  score_version: string;
  first_detected_at: string;
  last_detected_at: string;
  classification_confidence: number;
}

/**
 * Signals older than this many days since their last evidence are no
 * longer treated as "the same ongoing signal" for dedup purposes, even
 * if their status row still reads 'active' (e.g. the expiration cron
 * from spec §7.2 hasn't swept it yet). Hiring that resumes after a
 * multi-month lull is a new occurrence a user should be told about, not
 * silently folded into a stale row nobody's looked at since.
 */
const ACTIVE_SIGNAL_LOOKBACK_DAYS = 28;

/**
 * Dedup check per spec §7.3's hard-duplicate rule applied at the signal
 * level: an active signal for the same (company, role, type) should be
 * refreshed (new evidence appended, score/last_detected_at updated), not
 * duplicated as a second row. Only considers status='active' -- an
 * expired signal for the same triple is a legitimately new occurrence
 * (e.g. hiring resumed after a lull), not a duplicate of the old one.
 *
 * Also bounded by ACTIVE_SIGNAL_LOOKBACK_DAYS: an 'active' row whose
 * last_detected_at is further back than that is treated as not-a-match
 * here, so a fresh burst after a long pause creates a new signal instead
 * of quietly refreshing (and thus resurrecting) a dormant one.
 */
export async function findActiveSignal(
  client: D1Client,
  params: { companyId: string; roleCategory: RoleCategory; signalType: SignalType },
): Promise<SignalRowMinimal | null> {
  return client.first<SignalRowMinimal>(
    `SELECT id, status, score, first_detected_at, last_detected_at
     FROM signals
     WHERE company_id = ? AND role_category = ? AND signal_type = ? AND status = 'active'
       AND last_detected_at >= datetime('now', '-${ACTIVE_SIGNAL_LOOKBACK_DAYS} days')`,
    [params.companyId, params.roleCategory, params.signalType],
  );
}

export interface CreateSignalInput {
  companyId: string;
  roleCategory: RoleCategory;
  signalType: SignalType;
  score: number;
  scoreVersion: string;
  detectedAt: string;
  headline: string;
  summary: string;
}

/**
 * Inserts a new signal row. Callers (the ingest consumer, ROADMAP.md
 * Milestone D) must call findActiveSignal first and only reach this
 * function when no active signal exists for the (company, role, type)
 * triple -- this function does not check for you, since checking here
 * would mean an extra round trip on the common "signal already exists,
 * just append evidence" path.
 */
export async function createSignal(client: D1Client, input: CreateSignalInput): Promise<string> {
  const id = crypto.randomUUID();
  await client.run(
    `INSERT INTO signals (
       id, company_id, role_category, signal_type, status, score,
       score_version, first_detected_at, last_detected_at, expires_at,
       headline, summary
     ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.companyId,
      input.roleCategory,
      input.signalType,
      input.score,
      input.scoreVersion,
      input.detectedAt,
      input.detectedAt,
      input.headline,
      input.summary,
    ],
  );
  return id;
}

export interface RefreshSignalInput {
  score: number;
  scoreVersion: string;
  lastDetectedAt: string;
}

/**
 * Updates score/score_version/last_detected_at on an existing active
 * signal (the "refresh" path when findActiveSignal found a match).
 * first_detected_at is never touched -- it's the anchor for "how long
 * has this been an active signal," which spec §7.1's persistent_demand
 * signal type (a later milestone) will need intact.
 */
export async function refreshSignal(
  client: D1Client,
  signalId: string,
  input: RefreshSignalInput,
): Promise<void> {
  await client.run(
    `UPDATE signals SET score = ?, score_version = ?, last_detected_at = ? WHERE id = ?`,
    [input.score, input.scoreVersion, input.lastDetectedAt, signalId],
  );
}

export interface UpdateSignalScoreInput {
  score: number;
  scoreVersion: string;
}

/**
 * Reconciliation score update (ROADMAP.md H.5): refreshes the ranking
 * fields without touching last_detected_at, because no new evidence from
 * a source arrived. Mutating last_detected_at here would erase the very
 * staleness signal that reconciliation is meant to expose.
 */
export async function updateSignalScore(
  client: D1Client,
  signalId: string,
  input: UpdateSignalScoreInput,
): Promise<{ changes: number }> {
  return client.run(`UPDATE signals SET score = ?, score_version = ? WHERE id = ? AND status = 'active'`, [
    input.score,
    input.scoreVersion,
    signalId,
  ]);
}

/**
 * Active signals whose most recent real evidence is older than the
 * reconciliation threshold. The classification-confidence input for Q is
 * derived from the best currently active/possibly_closed matching job for
 * the same company+role; if none exists (e.g. all jobs closed after the
 * signal was created), Q falls back to 0 so the recomputed score decays
 * safely instead of preserving stale confidence from old evidence JSON.
 *
 * Excludes signals that already have a `score_recomputed` evidence row
 * inside the same 24-hour reconciliation window. `last_detected_at` is
 * intentionally not moved by reconciliation, so this recent-evidence guard
 * is what makes cron retries/manual double-runs idempotent-ish instead of
 * appending duplicate daily decay evidence for the same stale row.
 */
export async function listSignalsNeedingReconciliation(
  client: D1Client,
  params: { staleBefore: string; limit: number },
): Promise<SignalReconciliationRow[]> {
  return client.all<SignalReconciliationRow>(
    `SELECT
       s.id,
       s.company_id,
       s.role_category,
       s.signal_type,
       s.score,
       s.score_version,
       s.first_detected_at,
       s.last_detected_at,
       COALESCE(MAX(j.classification_confidence), 0) AS classification_confidence
     FROM signals s
     LEFT JOIN jobs j
       ON j.company_id = s.company_id
      AND j.role_primary = s.role_category
      AND j.status IN ('active', 'possibly_closed')
     WHERE s.status = 'active'
       AND s.last_detected_at < ?
       AND NOT EXISTS (
         SELECT 1
         FROM signal_evidence se
         WHERE se.signal_id = s.id
           AND se.evidence_type = 'score_recomputed'
           AND se.observed_at >= ?
       )
     GROUP BY s.id
     ORDER BY s.last_detected_at ASC, s.id ASC
     LIMIT ?`,
    [params.staleBefore, params.staleBefore, params.limit],
  );
}

export interface AppendSignalEvidenceInput {
  signalId: string;
  jobId: string | null;
  evidenceType: string;
  observedAt: string;
  /** Serialized to JSON and stored in payload_json. Must include every
   * component score, formula version, and input per spec §7.2's
   * recomputability requirement -- callers should pass the full
   * ScoreResult from packages/domain's computeNewJobScore, not just the
   * final number. */
  payload: unknown;
}

/**
 * One row per (signal, evidence event) per spec §8.2's signal_evidence
 * table. Called once per createSignal/refreshSignal so every score
 * change has an accompanying evidence row explaining its inputs (spec
 * §7.2: "A user should be able to answer 'why is this ranked 82?' from
 * the detail screen" -- getSignalDetail in signals-repo.ts already reads
 * this table and returns it verbatim to the API).
 */
export async function appendSignalEvidence(
  client: D1Client,
  input: AppendSignalEvidenceInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await client.run(
    `INSERT INTO signal_evidence (id, signal_id, job_id, evidence_type, observed_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.signalId, input.jobId, input.evidenceType, input.observedAt, JSON.stringify(input.payload)],
  );
  return id;
}
