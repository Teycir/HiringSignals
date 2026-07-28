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

/**
 * Dedup check per spec §7.3's hard-duplicate rule applied at the signal
 * level: an active signal for the same (company, role, type) should be
 * refreshed (new evidence appended, score/last_detected_at updated), not
 * duplicated as a second row. Only considers status='active' -- an
 * expired signal for the same triple is a legitimately new occurrence
 * (e.g. hiring resumed after a lull), not a duplicate of the old one.
 */
export async function findActiveSignal(
  client: D1Client,
  params: { companyId: string; roleCategory: RoleCategory; signalType: SignalType },
): Promise<SignalRowMinimal | null> {
  return client.first<SignalRowMinimal>(
    `SELECT id, status, score, first_detected_at, last_detected_at
     FROM signals
     WHERE company_id = ? AND role_category = ? AND signal_type = ? AND status = 'active'`,
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
