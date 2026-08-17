import { roleCategorySchema, signalScoreSchema, signalTypeSchema } from "@hiring-signals/domain";
import type { RoleCategory, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import { isUniqueConstraintError } from "../../../lib/d1/unique-constraint";
import { CorruptSignalRowError } from "./signals-repo";

/**
 * Write-path repo for `signals`/`signal_evidence` (ROADMAP.md Milestone
 * C, spec §7). Kept separate from the read-only signals-repo.ts -- that
 * file's query-building style (cursor pagination, EXISTS filters,
 * per-row degrade) is read-optimized and unrelated to the write
 * concerns here (dedup checks, single-row inserts). Mixing the two would
 * make signals-repo.ts harder to reason about for either purpose.
 */

/**
 * Thrown by createSignal/refreshSignal/updateSignalScore when the
 * caller-supplied score fails domain's signalScoreSchema (an integer in
 * [0,100], the same contract the `signals.score INTEGER NOT NULL`
 * column implies but doesn't itself enforce). Without this check, a
 * caller that forgot to route through computeNewJobScore's own
 * round(min(100,max(0,...))) -- a non-integer from bad arithmetic, a
 * negative value, or an over-100 value from an upstream clamp bug --
 * would be written verbatim: SQLite's INTEGER affinity silently
 * truncates a non-integer, and out-of-range values persist with no
 * diagnostic. Same "client-caused error, not a server fault" pattern as
 * InvalidCursorError in signals-repo.ts -- callers map it to whatever's
 * appropriate for their context.
 */
export class InvalidSignalScoreError extends Error {
  constructor(score: number) {
    super(`Invalid signal score ${score}: must be an integer in [0, 100].`);
    this.name = "InvalidSignalScoreError";
  }
}

function assertValidScore(score: number): void {
  if (!signalScoreSchema.safeParse(score).success) {
    throw new InvalidSignalScoreError(score);
  }
}

/**
 * Thrown when createSignal's INSERT violates migration 0006's
 * `idx_signals_one_active_per_role` partial UNIQUE index (one active
 * signal per (company_id, role_category, signal_type)). This is the
 * genuine TOCTOU race the index exists to catch: two concurrent callers
 * both ran findActiveSignal, both saw no match, and both reached
 * createSignal for the same triple -- the DB constraint is the actual
 * enforcement point, this error just gives the loser of the race a
 * typed signal instead of a raw D1 constraint message. Same
 * "client-caused error, not a server fault" pattern as
 * DuplicateCompanyError/DuplicateSourceError. Callers should treat this
 * as "someone else just created it -- re-run findActiveSignal and
 * refresh that row instead," not as an unrecoverable failure.
 */
export class DuplicateActiveSignalError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly roleCategory: RoleCategory,
    public readonly signalType: SignalType,
  ) {
    super(
      `An active signal already exists for company_id="${companyId}", role_category="${roleCategory}", signal_type="${signalType}".`,
    );
    this.name = "DuplicateActiveSignalError";
  }
}

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

/** Raw D1 row shape before enum validation -- role_category/signal_type
 * are untyped strings here, same as signals-repo.ts's SignalRow, since
 * the DB doesn't itself enforce the domain enum. */
interface RawSignalReconciliationRow {
  id: string;
  company_id: string;
  role_category: string;
  signal_type: string;
  score: number;
  score_version: string;
  first_detected_at: string;
  last_detected_at: string;
  classification_confidence: number;
}

/**
 * Validates role_category/signal_type against domain's enums, same
 * per-row degrade discipline as signals-repo.ts's toListItem/
 * CorruptSignalRowError -- a stale write, manual edit, or taxonomy
 * change that put an invalid value in one of these columns should throw
 * a typed, identifiable error instead of silently trusting the DB and
 * letting the corrupt value flow into reconciliation.ts's downstream
 * getCompanyRoleActivityStats/updateSignalScore calls.
 */
function toReconciliationRow(row: RawSignalReconciliationRow): SignalReconciliationRow {
  const roleCategory = roleCategorySchema.safeParse(row.role_category);
  if (!roleCategory.success) {
    throw new CorruptSignalRowError(
      `Signal ${row.id} has invalid role_category="${row.role_category}".`,
    );
  }
  const signalType = signalTypeSchema.safeParse(row.signal_type);
  if (!signalType.success) {
    throw new CorruptSignalRowError(
      `Signal ${row.id} has invalid signal_type="${row.signal_type}".`,
    );
  }
  return { ...row, role_category: roleCategory.data, signal_type: signalType.data };
}

/**
 * Signals older than this many days since their last evidence are no
 * longer treated as "the same ongoing signal" for dedup purposes, even
 * if their status row still reads 'active' (e.g. the expiration cron
 * from spec §7.2 hasn't swept it yet). Hiring that resumes after a
 * multi-month lull is a new occurrence a user should be told about, not
 * silently folded into a stale row nobody's looked at since.
 *
 * ROADMAP.md J.5 (2026-08-05): must stay >= ingest-consumer.ts's
 * PERSISTENT_DEMAND_MIN_DAYS_ACTIVE (30). A signal can only ever cross
 * that threshold by first surviving >=30 days without a status change
 * -- if this lookback window were shorter than that, findActiveSignal
 * would stop finding the row (treating it as "dormant, start fresh")
 * before it could ever reach the refresh path that carries
 * first_detected_at forward and lets persistent_demand's day-count
 * evaluate correctly. Set to 35, not the bare minimum of 30 or 31, to
 * leave headroom for the reconciliation cron's own polling cadence
 * (spec §7.2) landing a few days later than the exact 30-day mark
 * without the same problem resurfacing at the boundary. If
 * PERSISTENT_DEMAND_MIN_DAYS_ACTIVE ever changes, this must be
 * re-checked against it -- not otherwise coupled in code, since the two
 * constants live in different packages (db vs. the api app) and no
 * shared import connects them today.
 */
const ACTIVE_SIGNAL_LOOKBACK_DAYS = 35;

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
 *
 * The lookback cutoff is computed in JS and bound as a real `?`
 * parameter, never interpolated into the SQL text -- AGENTS.md's
 * repo-wide rule ("Every SQL query is parameterized via .bind(). Never
 * interpolate values into SQL text") applies to every value, including
 * ones that happen to be internal constants today, since there's no
 * structural guard stopping a future caller from making the lookback
 * window caller-configurable and turning this into a live SQLi vector.
 * This also fixes a second issue for free: computing the cutoff from
 * the Worker's own `Date.now()` instead of `datetime('now', ...)`
 * removes the D1/SQLite-runtime-clock vs. Worker-clock skew that could
 * otherwise make the 28-day boundary non-deterministic.
 */
export async function findActiveSignal(
  client: D1Client,
  params: {
    companyId: string;
    roleCategory: RoleCategory;
    signalType: SignalType;
    nowIso?: string;
  },
): Promise<SignalRowMinimal | null> {
  return client.first<SignalRowMinimal>(
    `SELECT id, status, score, first_detected_at, last_detected_at
     FROM signals
     WHERE company_id = ? AND role_category = ? AND signal_type = ? AND status = 'active'
       AND last_detected_at >= datetime('now', ?)`,
    [params.companyId, params.roleCategory, params.signalType, `-${ACTIVE_SIGNAL_LOOKBACK_DAYS} days`],
  );
}

/**
 * ROADMAP.md J.5 (2026-08-05): recovery lookup for createSignal's
 * DuplicateActiveSignalError catch. Deliberately NOT findActiveSignal
 * with a longer/no cutoff passed in -- this is a distinct, narrower
 * query used only after the UNIQUE index has already told the caller a
 * matching active row genuinely exists right now (the INSERT failed
 * because of it), so there's no dormancy judgment left to make here:
 * unlike findActiveSignal's real dedup decision (is this active row
 * recent enough to represent the same ongoing signal, or should a new
 * one start), by the time this runs that question is already settled
 * by the constraint violation itself. Kept as its own function rather
 * than an optional-cutoff parameter on findActiveSignal so a future
 * reader can't accidentally pass a permissive cutoff into the real dedup
 * check and quietly reintroduce the resurrection behavior
 * ACTIVE_SIGNAL_LOOKBACK_DAYS exists to prevent.
 */
export async function findActiveSignalIgnoringLookback(
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

/**
 * Batch variant of findActiveSignal: same dedup lookup (same
 * ACTIVE_SIGNAL_LOOKBACK_DAYS cutoff, same status='active' filter), but
 * for several signal_type values for one (company, role) pair in ONE
 * round trip via `signal_type IN (...)`, instead of N separate
 * findActiveSignal calls. ROADMAP.md J.1 (2026-08-04): built for
 * generateCompanySignals's H.4 loop (apps/api/src/jobs/
 * ingest-consumer.ts), which previously called findActiveSignal once
 * per triggered company-level signal type (up to 4 sequential D1 round
 * trips just for this one read) -- this collapses that to 1.
 *
 * Returns a Map keyed by signal_type so the caller can look up
 * "does an active signal already exist for this type" in O(1) per type
 * without re-scanning an array -- a signal_type with no active match
 * simply has no key in the returned map (not an explicit `null` entry),
 * mirroring how a missing key in a plain object/Map already means
 * "absent" without needing a sentinel value.
 */
export async function findActiveSignalsBatch(
  client: D1Client,
  params: {
    companyId: string;
    roleCategory: RoleCategory;
    signalTypes: SignalType[];
    nowIso?: string;
  },
): Promise<Map<SignalType, SignalRowMinimal>> {
  const result = new Map<SignalType, SignalRowMinimal>();
  if (params.signalTypes.length === 0) {
    // No types to look up -- skip the round trip entirely rather than
    // building a SQL `IN ()` with zero placeholders (invalid syntax in
    // some dialects, same reasoning as getJobsMissingFromRun's empty-list
    // guard in jobs-repo.ts).
    return result;
  }
  const placeholders = params.signalTypes.map(() => "?").join(",");
  const rows = await client.all<SignalRowMinimal & { signal_type: string }>(
    `SELECT id, signal_type, status, score, first_detected_at, last_detected_at
     FROM signals
     WHERE company_id = ? AND role_category = ? AND signal_type IN (${placeholders}) AND status = 'active'
       AND last_detected_at >= datetime('now', ?)`,
    [params.companyId, params.roleCategory, ...params.signalTypes, `-${ACTIVE_SIGNAL_LOOKBACK_DAYS} days`],
  );
  for (const row of rows) {
    // signal_type here came from params.signalTypes (already-validated
    // SignalType values this same call passed in as bind params), so a
    // plain cast is safe -- no untrusted/external value flows through
    // this column the way signals-repo.ts's toListItem/CorruptSignalRowError
    // guards against for rows read without a type filter.
    result.set(row.signal_type as SignalType, {
      id: row.id,
      status: row.status,
      score: row.score,
      first_detected_at: row.first_detected_at,
      last_detected_at: row.last_detected_at,
    });
  }
  return result;
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
  /** ScoreComponents (ROADMAP V.3, migration 0010): persisted alongside
   * the final score so GET /signals/:id can surface them on the detail
   * page. Optional -- old callers that don't supply them produce null
   * columns, which the UI degrades to the generic formula description. */
  scoreComponents?: {
    freshness: number;
    volume: number;
    acceleration: number;
    breadth: number;
    confidence: number;
  };
}

/**
 * Inserts a new signal row. Callers (the ingest consumer, ROADMAP.md
 * Milestone D) must call findActiveSignal first and only reach this
 * function when no active signal exists for the (company, role, type)
 * triple -- this function does not check for you, since checking here
 * would mean an extra round trip on the common "signal already exists,
 * just append evidence" path.
 *
 * Migration 0006's partial UNIQUE index is the real enforcement for
 * that invariant (findActiveSignal + this function is otherwise a
 * check-then-act race) -- a violation here means a concurrent caller
 * won the race and already created the active row this call was also
 * trying to create, surfaced as DuplicateActiveSignalError instead of a
 * raw D1 constraint message.
 */
export async function createSignal(client: D1Client, input: CreateSignalInput): Promise<string> {
  assertValidScore(input.score);
  const id = crypto.randomUUID();
  const c = input.scoreComponents;
  try {
    await client.run(
      `INSERT INTO signals (
         id, company_id, role_category, signal_type, status, score,
         score_version, first_detected_at, last_detected_at, expires_at,
         headline, summary,
         score_freshness, score_volume, score_acceleration, score_breadth, score_confidence
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
        c?.freshness ?? null,
        c?.volume ?? null,
        c?.acceleration ?? null,
        c?.breadth ?? null,
        c?.confidence ?? null,
      ],
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DuplicateActiveSignalError(input.companyId, input.roleCategory, input.signalType);
    }
    throw err;
  }
  return id;
}

export interface RefreshSignalInput {
  score: number;
  scoreVersion: string;
  lastDetectedAt: string;
  /** ScoreComponents (ROADMAP V.3, migration 0010): updated alongside
   * the score on every refresh so the detail page always reflects the
   * most recent computation. Optional for backward compat. */
  scoreComponents?: {
    freshness: number;
    volume: number;
    acceleration: number;
    breadth: number;
    confidence: number;
  };
}

/**
 * Updates score/score_version/last_detected_at on an existing active
 * signal (the "refresh" path when findActiveSignal found a match).
 * first_detected_at is never touched -- it's the anchor for "how long
 * has this been an active signal," which spec §7.1's persistent_demand
 * signal type (a later milestone) will need intact.
 *
 * companyId is required (debug-codebase-audit.md H1, same tenant-
 * isolation defense-in-depth as sources-repo.ts's updateSource/
 * jobs-repo.ts's applyLifecycleTransition): both real call sites
 * (ingest-consumer.ts's two refreshSignal calls) already have
 * `source.company_id` in scope from the same source row that produced
 * the signal's companyId via findActiveSignal -- this is a defense-in-
 * depth qualifier, not new plumbing. A caller passing a mismatched
 * companyId for a genuine signalId now affects 0 rows instead of
 * silently mutating another company's signal.
 *
 * `status = 'active'` guard, same race-safety reasoning as
 * updateSignalScore/markSignalStillActive below: without it, a signal
 * that flips to 'expired' (expiration cron) between the caller's
 * findActiveSignal SELECT and this UPDATE would have its
 * last_detected_at/score bumped anyway, resurrecting an expired signal
 * until the cron sweeps it again. The write becomes a no-op instead.
 *
 * Returns `{ changes: number }`, mirroring updateSignalScore/
 * markSignalStillActive -- previously this returned `void`, discarding
 * client.run()'s own `{ changes }` result. That made the H1
 * tenant-mismatch guard and the status='active' race guard above
 * silently indistinguishable from success: a caller had no way to know
 * 0 rows were touched and would go on to call appendSignalEvidence for
 * a signal whose last_detected_at was never actually bumped. Callers
 * should check `changes === 0` and skip the evidence append, same
 * pattern reconciliation.ts already uses for the other two functions.
 */
export async function refreshSignal(
  client: D1Client,
  signalId: string,
  companyId: string,
  input: RefreshSignalInput,
): Promise<{ changes: number }> {
  assertValidScore(input.score);
  const c = input.scoreComponents;
  return client.run(
    `UPDATE signals
     SET score = ?, score_version = ?, last_detected_at = ?,
         score_freshness = ?, score_volume = ?, score_acceleration = ?,
         score_breadth = ?, score_confidence = ?
     WHERE id = ? AND company_id = ? AND status = 'active'`,
    [
      input.score,
      input.scoreVersion,
      input.lastDetectedAt,
      c?.freshness ?? null,
      c?.volume ?? null,
      c?.acceleration ?? null,
      c?.breadth ?? null,
      c?.confidence ?? null,
      signalId,
      companyId,
    ],
  );
}

export interface UpdateSignalScoreInput {
  score: number;
  scoreVersion: string;
  /** ScoreComponents (ROADMAP V.3, migration 0010): updated at reconciliation
   * time so the detail page always shows the latest computation. Optional. */
  scoreComponents?: {
    freshness: number;
    volume: number;
    acceleration: number;
    breadth: number;
    confidence: number;
  };
}

/**
 * Reconciliation score update (ROADMAP.md H.5): refreshes the ranking
 * fields without touching last_detected_at, because no new evidence from
 * a source arrived. Mutating last_detected_at here would erase the very
 * staleness signal that reconciliation is meant to expose.
 *
 * companyId is required (debug-codebase-audit.md H1, same tenant-
 * isolation defense-in-depth as refreshSignal above): reconciliation.ts's
 * only call site already has `signal.company_id` in scope from
 * listSignalsNeedingReconciliation's own SELECT.
 */
export async function updateSignalScore(
  client: D1Client,
  signalId: string,
  companyId: string,
  input: UpdateSignalScoreInput,
): Promise<{ changes: number }> {
  assertValidScore(input.score);
  const c = input.scoreComponents;
  return client.run(
    `UPDATE signals
     SET score = ?, score_version = ?,
         score_freshness = ?, score_volume = ?, score_acceleration = ?,
         score_breadth = ?, score_confidence = ?
     WHERE id = ? AND company_id = ? AND status = 'active'`,
    [
      input.score,
      input.scoreVersion,
      c?.freshness ?? null,
      c?.volume ?? null,
      c?.acceleration ?? null,
      c?.breadth ?? null,
      c?.confidence ?? null,
      signalId,
      companyId,
    ],
  );
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
 *
 * Per-row degrade for role_category/signal_type (same discipline as
 * signals-repo.ts's listSignals): a stale enum value, manual edit, or
 * taxonomy change on one row must not fail the entire reconciliation
 * batch, especially since this repo function has no per-item try/catch
 * of its own the way the read-repo's page-rendering caller does --
 * skipping and logging here, before the bad row ever reaches
 * reconciliation.ts, keeps that guarantee without pushing enum-
 * validation concerns into the caller.
 */
export async function listSignalsNeedingReconciliation(
  client: D1Client,
  params: { staleBefore: string; limit: number },
): Promise<SignalReconciliationRow[]> {
  const rows = await client.all<RawSignalReconciliationRow>(
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

  const validated: SignalReconciliationRow[] = [];
  for (const row of rows) {
    try {
      validated.push(toReconciliationRow(row));
    } catch (err) {
      if (err instanceof CorruptSignalRowError) {
        console.error("corrupt_signal_row_skipped_reconciliation", {
          signalId: row.id,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }
  return validated;
}

/**
 * Row shape for `still_active` candidates (ROADMAP.md K.1, spec §1.4:
 * "a previously surfaced matching job remains open at the most recent
 * successful check"). One row per (signal, backing job) pair so the
 * caller can pass the specific job's `last_seen_at`/id through to the
 * evidence payload without a second lookup -- mirrors
 * SignalReconciliationRow's "one query, everything the caller needs"
 * shape above.
 */
export interface StillActiveCandidateRow {
  signal_id: string;
  company_id: string;
  role_category: RoleCategory;
  last_detected_at: string;
  job_id: string;
  job_last_seen_at: string;
  poll_interval_minutes: number;
}

/**
 * Active signals whose most recent detection is stale (default: 24h+,
 * same STALE_SIGNAL_AFTER_HOURS cadence as H.5's score reconciliation --
 * both run once/day off the same cron) but whose backing job was seen
 * recently by its own source's polling cadence, per source. "Recently"
 * is source-relative (`poll_interval_minutes * multiplier`), not a fixed
 * constant -- a source polled every 90 minutes and one polled every 24h
 * both count as "still active" on their own cadence, not one shared
 * clock (spec §15's own detection-latency target is likewise per-source
 * `pollIntervalMinutes`-relative, same reasoning).
 *
 * Deliberately does NOT restrict to signal_type = 'new_job': spec §1.4
 * scopes "still active" to role-level signals generically ("a previously
 * surfaced matching job"), and `reopened_job` is exactly as eligible --
 * a job that reappeared and is still open is just as worth confirming as
 * one that was new. Company-level signal types (hiring_burst,
 * role_acceleration, multi_location, persistent_demand) don't anchor to
 * one single job the same way, so those naturally fall out of this query
 * because they don't have a qualifying still-open evidence job either
 * (their evidence jobs are frequently closed by the time the signal
 * itself is still meaningful).
 *
 * Idempotency guard: excludes signals with a `still_active` evidence row
 * already recorded today (UTC calendar day of `todayStart`), mirroring
 * listSignalsNeedingReconciliation's `score_recomputed`-within-window
 * guard -- makes a cron retry/manual re-run safe without appending a
 * second confirmation the same day.
 *
 * One row per (signal, job) pair when a signal has more than one
 * still-open evidence job (rare but possible for company-level types
 * that slip through, or a role-level signal with multiple evidence
 * jobs) -- caller picks the freshest (`MAX(job_last_seen_at)`) per
 * signal, which the `GROUP BY s.id` + `MAX()` below already resolves in
 * SQL rather than pushing dedup into application code.
 */
export async function listStillActiveCandidates(
  client: D1Client,
  params: {
    now: string;
    staleBefore: string;
    todayStart: string;
    lookbackMultiplier: number;
    limit: number;
  },
): Promise<StillActiveCandidateRow[]> {
  // The `datetime(?, ...)` cutoff below is compared against `j.last_seen_at`
  // using plain string `>=` (D1/SQLite has no real datetime type). SQLite's
  // datetime() normalizes its *output* to space-separated, no-`Z` form
  // ("2026-07-30 03:45:00"), which does not lexicographically compare
  // correctly against the ISO-8601 "T"/"Z" form ("2026-07-30T00:00:00.000Z")
  // stored in last_seen_at -- 'T' (0x54) sorts after ' ' (0x20), so a
  // T-formatted value spuriously compares as >= almost any datetime()
  // output regardless of actual chronological order. Wrapping last_seen_at
  // in datetime() too normalizes both sides to the same space-separated
  // form before comparison, so the comparison is actually correct.
  return client.all<StillActiveCandidateRow>(
    `SELECT
       s.id AS signal_id,
       s.company_id,
       s.role_category,
       s.last_detected_at,
       j.id AS job_id,
       MAX(j.last_seen_at) AS job_last_seen_at,
       src.poll_interval_minutes AS poll_interval_minutes
     FROM signals s
     JOIN signal_evidence se ON se.signal_id = s.id AND se.job_id IS NOT NULL
     JOIN jobs j ON j.id = se.job_id
     JOIN sources src ON src.id = j.source_id
     WHERE s.status = 'active'
       AND s.last_detected_at < ?
       AND j.status = 'active'
       AND datetime(j.last_seen_at) >= datetime(?, '-' || CAST(src.poll_interval_minutes * ? AS TEXT) || ' minutes')
       AND NOT EXISTS (
         SELECT 1 FROM signal_evidence se2
         WHERE se2.signal_id = s.id
           AND se2.evidence_type = 'still_active'
           AND se2.observed_at >= ?
       )
     GROUP BY s.id
     ORDER BY s.last_detected_at ASC, s.id ASC
     LIMIT ?`,
    [params.staleBefore, params.now, params.lookbackMultiplier, params.todayStart, params.limit],
  );
}

export interface MarkSignalStillActiveInput {
  lastDetectedAt: string;
}

/**
 * Bumps `last_detected_at` on an active signal WITHOUT touching
 * score/score_version -- distinct from both refreshSignal (new real
 * evidence, also updates score) and updateSignalScore (score decay,
 * deliberately does NOT touch last_detected_at). A still_active
 * confirmation is genuinely new evidence that the signal remains
 * current, so it earns a last_detected_at bump (unlike reconciliation's
 * score-only recompute), but it doesn't represent new hiring activity,
 * so the score itself is untouched (unlike refreshSignal's new-job-
 * evidence path).
 *
 * `status = 'active'` guard, same race-safety reasoning as
 * updateSignalScore -- if something else expired the signal between
 * listStillActiveCandidates's SELECT and this UPDATE, the write becomes
 * a no-op and the caller (K.1's reconciliation pass) skips the
 * evidence-append, same "changes === 0 -> skip" pattern H.5 already
 * uses.
 *
 * companyId is required (debug-codebase-audit.md H1, same tenant-
 * isolation defense-in-depth as updateSignalScore above):
 * reconciliation.ts's only call site already has
 * `candidate.company_id` in scope from listStillActiveCandidates's own
 * SELECT.
 */
export async function markSignalStillActive(
  client: D1Client,
  signalId: string,
  companyId: string,
  input: MarkSignalStillActiveInput,
): Promise<{ changes: number }> {
  return client.run(
    `UPDATE signals SET last_detected_at = ? WHERE id = ? AND company_id = ? AND status = 'active'`,
    [input.lastDetectedAt, signalId, companyId],
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
 * Serializes `payload` for storage, guarding against JSON.stringify's
 * deterministic throws on circular references and BigInt values.
 * `payload: unknown` on AppendSignalEvidenceInput explicitly allows any
 * shape -- current callers only ever pass a ScoreResult (safe), but the
 * signature is a footgun for future callers, so this fails predictably
 * (a clear error) instead of crashing the caller's transaction with an
 * opaque TypeError deep inside an INSERT.
 */
function serializeEvidencePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`appendSignalEvidence: payload is not JSON-serializable (${reason})`, {
      cause: error,
    });
  }
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
    [
      id,
      input.signalId,
      input.jobId,
      input.evidenceType,
      input.observedAt,
      serializeEvidencePayload(input.payload),
    ],
  );
  return id;
}
