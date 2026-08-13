import type { AtsProvider } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import { isUniqueConstraintError } from "../../../lib/d1/unique-constraint";

/**
 * Thrown when INSERT into `sources` violates the `UNIQUE(provider,
 * board_token)` constraint (migration 0001). Framework-agnostic on
 * purpose -- packages/db must not depend on hono (see AGENTS.md "How to
 * work in this repo"). Caught by the local ops source-management script
 * (ROADMAP.md Milestone D, spec §10.5) and printed as a clear message
 * instead of a raw D1 constraint error -- there is no HTTP admin route
 * to map this to a status code, source management is not a Worker route.
 */
export class DuplicateSourceError extends Error {
  constructor(
    public readonly provider: string,
    public readonly boardToken: string,
  ) {
    super(`Source already exists for provider="${provider}" boardToken="${boardToken}".`);
    this.name = "DuplicateSourceError";
  }
}

/** Raw D1 row shape (snake_case) for the `sources` table. */
export interface SourceRow {
  id: string;
  company_id: string;
  provider: string;
  board_token: string;
  public_url: string;
  enabled: number;
  poll_interval_minutes: number;
  next_poll_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
}

const SOURCE_COLUMNS = `id, company_id, provider, board_token, public_url, enabled,
       poll_interval_minutes, next_poll_at, last_success_at, consecutive_failures`;

/**
 * Sources whose next poll is due, ordered so the earliest-due sources are
 * enqueued first. Backs the scheduler (ROADMAP.md Milestone D) -- the
 * scheduler must only call this + enqueue, never fetch (spec §5.1/§5.2).
 *
 * `next_poll_at IS NULL` matches never-yet-polled sources (spec §8.2's
 * column is nullable for exactly this reason -- a freshly created source
 * has no prior run to compute a next-poll time from).
 *
 * Uses idx_source_due (migration 0001: `sources(enabled, next_poll_at)`).
 * Verify with EXPLAIN QUERY PLAN once seed data exists (ROADMAP.md A.1) --
 * don't assume the index is hit just because it exists.
 */
export async function getDueSources(
  client: D1Client,
  params: { now: string; limit: number },
): Promise<SourceRow[]> {
  return client.all<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM sources
     WHERE enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?)
     ORDER BY next_poll_at ASC
     LIMIT ?`,
    [params.now, params.limit],
  );
}

/** Single source row, used by the queue consumer to re-load config per message. */
export async function getSourceById(client: D1Client, sourceId: string): Promise<SourceRow | null> {
  return client.first<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`, [sourceId]);
}

export interface SourceSummary {
  id: string;
  companyId: string;
  provider: string;
  publicUrl: string;
  enabled: boolean;
  pollIntervalMinutes: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

function toSummary(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    publicUrl: row.public_url,
    enabled: row.enabled === 1,
    pollIntervalMinutes: row.poll_interval_minutes,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
  };
}

export async function listSources(
  client: D1Client,
  params: { companyId?: string; limit: number },
): Promise<SourceSummary[]> {
  if (params.companyId) {
    const rows = await client.all<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM sources WHERE company_id = ? ORDER BY provider ASC, id ASC LIMIT ?`,
      [params.companyId, params.limit],
    );
    return rows.map(toSummary);
  }
  const rows = await client.all<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY provider ASC, id ASC LIMIT ?`,
    [params.limit],
  );
  return rows.map(toSummary);
}

export interface CreateSourceInput {
  companyId: string;
  provider: AtsProvider;
  boardToken: string;
  publicUrl: string;
  enabled?: boolean;
  pollIntervalMinutes?: number;
}

/**
 * Inserts a new source. Duplicate `(provider, board_token)` throws
 * DuplicateSourceError instead of letting the raw D1 constraint error
 * surface -- the ops source-management script (ROADMAP.md Milestone D,
 * spec §10.5) catches it and prints a clear message. There is no HTTP
 * route in front of this; source management is a local script, not a
 * Worker endpoint.
 *
 * `next_poll_at` is left NULL on creation (see getDueSources) so a new
 * source is immediately due on the next scheduler tick rather than
 * waiting a full poll interval before its first fetch.
 */
export async function createSource(client: D1Client, input: CreateSourceInput): Promise<SourceRow> {
  const id = crypto.randomUUID();
  const enabled = input.enabled ?? true;
  const pollIntervalMinutes = input.pollIntervalMinutes ?? 360; // matches migration 0001 default

  try {
    await client.run(
      `INSERT INTO sources
         (id, company_id, provider, board_token, public_url, enabled,
          poll_interval_minutes, next_poll_at, last_success_at, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
      [id, input.companyId, input.provider, input.boardToken, input.publicUrl, enabled ? 1 : 0, pollIntervalMinutes],
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DuplicateSourceError(input.provider, input.boardToken);
    }
    throw err;
  }

  return {
    id,
    company_id: input.companyId,
    provider: input.provider,
    board_token: input.boardToken,
    public_url: input.publicUrl,
    enabled: enabled ? 1 : 0,
    poll_interval_minutes: pollIntervalMinutes,
    next_poll_at: null,
    last_success_at: null,
    consecutive_failures: 0,
  };
}

export interface UpdateSourcePatch {
  enabled?: boolean;
  pollIntervalMinutes?: number;
  publicUrl?: string;
  nextPollAt?: string | null;
}

/**
 * Partial update for the ops source-management script (enable/disable,
 * change schedule) -- spec §10.5, not an HTTP admin route.
 * Only touches columns present in `patch` -- callers pass just what
 * changed, same convention as the rest of this repo's write functions.
 * Returns false if no row matched `sourceId` (the script prints a "not
 * found" message), true otherwise.
 */
/**
 * companyId is required (roadmapfix.md F1a, tenant-isolation
 * defense-in-depth): every genuine caller has an already-loaded source
 * row (and thus its company_id) in scope -- see ingest-consumer.ts's
 * finalizeConfigError, whose 4 call sites all run inside the same try
 * block that loaded `source`. companyId is checked, not just threaded
 * through for show: a caller that genuinely doesn't have it yet (a
 * hoisted `source` still `undefined` because getSourceById itself never
 * resolved) fails the WHERE clause -- 0 rows affected -- instead of the
 * qualifier being silently skipped.
 */
export async function updateSource(
  client: D1Client,
  sourceId: string,
  companyId: string,
  patch: UpdateSourcePatch,
): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];

  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    args.push(patch.enabled ? 1 : 0);
  }
  if (patch.pollIntervalMinutes !== undefined) {
    sets.push("poll_interval_minutes = ?");
    args.push(patch.pollIntervalMinutes);
  }
  if (patch.publicUrl !== undefined) {
    sets.push("public_url = ?");
    args.push(patch.publicUrl);
  }
  if (patch.nextPollAt !== undefined) {
    sets.push("next_poll_at = ?");
    args.push(patch.nextPollAt);
  }

  if (sets.length === 0) return true; // nothing to change; not an error

  const result = await client.run(
    `UPDATE sources SET ${sets.join(", ")} WHERE id = ? AND company_id = ?`,
    [...args, sourceId, companyId],
  );
  return result.changes > 0;
}

/** source_runs row shape (snake_case), spec §8.2. */
export interface SourceRunRow {
  id: string;
  source_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  http_status: number | null;
  jobs_received: number | null;
  jobs_normalized: number | null;
  error_code: string | null;
  error_message_safe: string | null;
  raw_payload_key: string | null;
  duration_ms: number | null;
}

export interface RecordSourceRunStartInput {
  sourceId: string;
  startedAt: string;
}

/**
 * Opens a source_runs row at the start of a fetch attempt. Returns the
 * generated sourceRunId for the consumer (ROADMAP.md Milestone D) to
 * pass through the rest of the pipeline and to job_observations rows.
 *
 * status starts "running" -- recordSourceRunComplete (below) sets the
 * terminal status once the fetch/normalize/upsert pipeline finishes or
 * fails.
 */
export async function recordSourceRunStart(
  client: D1Client,
  input: RecordSourceRunStartInput,
): Promise<string> {
  const sourceRunId = crypto.randomUUID();
  await client.run(
    `INSERT INTO source_runs
       (id, source_id, started_at, completed_at, status, http_status,
        jobs_received, jobs_normalized, error_code, error_message_safe,
        raw_payload_key, duration_ms)
     VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [sourceRunId, input.sourceId, input.startedAt],
  );
  return sourceRunId;
}

/**
 * Opens (attempt=1) or reuses (attempt>1) a source_runs row keyed by the
 * queue message's own `runId` as the row's primary key, so retries of
 * the same logical run share one row instead of each attempt creating a
 * new one via recordSourceRunStart's crypto.randomUUID() -- this keeps
 * job_observations' UNIQUE(job_id, source_run_id) idempotency key
 * (migration 0004) meaningful across retries (spec §10.3: "A retry for
 * the same sourceId + runId must not create duplicate observations").
 *
 * Distinct from recordSourceRunStart above: that function always mints a
 * fresh id for a genuinely new run; this one's whole purpose is "same
 * runId in, same row out" across repeated calls. Previously inlined in
 * the ingest consumer as resolveSourceRunId with its own raw SQL; moved
 * here (ROADMAP.md P1 code-review finding) so the consumer goes through
 * the repo layer like every other write in its pipeline.
 */
export async function resolveSourceRun(
  client: D1Client,
  sourceId: string,
  runId: string,
  startedAt: string,
): Promise<string> {
  const existing = await client.first<{ id: string }>(
    `SELECT id FROM source_runs WHERE source_id = ? AND id = ?`,
    [sourceId, runId],
  );
  if (existing) return existing.id;

  await client.run(
    `INSERT INTO source_runs
       (id, source_id, started_at, completed_at, status, http_status,
        jobs_received, jobs_normalized, error_code, error_message_safe,
        raw_payload_key, duration_ms)
     VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [runId, sourceId, startedAt],
  );
  return runId;
}

/**
 * Max length for error_message_safe before truncation. Chosen to be
 * generous enough for a human-readable diagnostic while making it
 * structurally impossible to accidentally paste in a full raw response
 * body (spec §13.1: "never include ... full raw payloads").
 */
const ERROR_MESSAGE_SAFE_MAX_LENGTH = 500;

/**
 * Strips the message down to something safe to persist: no accidental
 * secrets/tokens/cookies, no full raw payload. This is a defense-in-depth
 * truncation, not a substitute for callers already passing a sanitized
 * message -- callers (the ingest-consumer's failure-handling branches,
 * ROADMAP.md Milestone D) are still responsible for not constructing the
 * message from raw response bodies in the first place. Enforced here (not
 * just by naming convention) per ROADMAP.md's explicit instruction.
 */
function sanitizeErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const truncated =
    message.length > ERROR_MESSAGE_SAFE_MAX_LENGTH
      ? `${message.slice(0, ERROR_MESSAGE_SAFE_MAX_LENGTH)}…(truncated)`
      : message;
  return truncated;
}

export interface RecordSourceRunCompleteInput {
  completedAt: string;
  status: string;
  httpStatus?: number;
  jobsReceived?: number;
  jobsNormalized?: number;
  errorCode?: string;
  errorMessageSafe?: string;
  rawPayloadKey?: string;
  durationMs?: number;
}

/** Closes out a source_runs row with the pipeline's final result. */
export async function recordSourceRunComplete(
  client: D1Client,
  sourceRunId: string,
  result: RecordSourceRunCompleteInput,
): Promise<void> {
  await client.run(
    `UPDATE source_runs
     SET completed_at = ?, status = ?, http_status = ?, jobs_received = ?,
         jobs_normalized = ?, error_code = ?, error_message_safe = ?,
         raw_payload_key = ?, duration_ms = ?
     WHERE id = ?`,
    [
      result.completedAt,
      result.status,
      result.httpStatus ?? null,
      result.jobsReceived ?? null,
      result.jobsNormalized ?? null,
      result.errorCode ?? null,
      sanitizeErrorMessage(result.errorMessageSafe),
      result.rawPayloadKey ?? null,
      result.durationMs ?? null,
      sourceRunId,
    ],
  );
}

/**
 * Diagnostic-only progress checkpoint (ROADMAP.md G.3 follow-up,
 * 2026-08-13): writes jobs_normalized mid-loop, WITHOUT touching status
 * or completed_at, so a source_runs row still reads status='running'
 * afterward -- this is deliberately NOT a state transition, just a
 * breadcrumb. Exists because the openai board (Ashby, 700+ jobs) has
 * been silently killed by Cloudflare's per-invocation subrequest cap
 * before completing even a single JOBS_PER_CHUNK-sized chunk, and that
 * kill happens at the platform level with zero JS-catchable error --
 * the ordinary completed_at/status/error_message_safe fields in
 * recordSourceRunComplete never get written for that failure mode, so
 * there was no way to tell how many jobs got through before the kill.
 * A temporary instrumentation aid, not a permanent feature -- remove
 * once the actual cap is confirmed and JOBS_PER_CHUNK is sized
 * correctly against real numbers instead of a manual estimate.
 */
export async function recordSourceRunProgress(
  client: D1Client,
  sourceRunId: string,
  jobsNormalizedSoFar: number,
): Promise<void> {
  await client.run(`UPDATE source_runs SET jobs_normalized = ? WHERE id = ?`, [
    jobsNormalizedSoFar,
    sourceRunId,
  ]);
}

/**
 * Marks a source run as successful: resets consecutive_failures to 0 and
 * advances the polling schedule. `nextPollAt` is computed by the caller
 * (now + poll_interval_minutes + jitter, per spec §5.2) -- this function
 * just persists it.
 *
 * consecutive_failures here is distinct from a job's missing_run_count
 * (jobs-repo.ts) -- this counts source-run failures, that counts a job's
 * absence from successful runs. Do not conflate the two (ROADMAP.md
 * Milestone A note, spec §5.4).
 */
/** companyId required, same roadmapfix.md F1a reasoning as updateSource above. */
export async function markSourceSuccess(
  client: D1Client,
  sourceId: string,
  companyId: string,
  nextPollAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await client.run(
    `UPDATE sources
     SET consecutive_failures = 0, last_success_at = ?, next_poll_at = ?
     WHERE id = ? AND company_id = ?`,
    [now, nextPollAt, sourceId, companyId],
  );
}

/**
 * Marks a source run as failed: increments consecutive_failures only.
 * Per spec §5.4 ("Source run fails → do not alter missing counts"), this
 * must NOT touch any job's missing_run_count -- that only moves on a
 * *successful* run that doesn't see the job (jobs-repo.ts).
 *
 * Does not touch next_poll_at here -- the failure-handling branches in
 * the ingest-consumer (ROADMAP.md Milestone D, spec §10.4) decide the
 * retry/backoff schedule per failure type (429, transient 5xx, config
 * error, etc.) and call updateSource with the resulting next_poll_at
 * themselves, rather than this function guessing a single backoff policy
 * for every failure kind.
 */
/**
 * companyId is `string | undefined` (not required like updateSource/
 * markSourceSuccess above, roadmapfix.md F1a) because 2 of this
 * function's real call sites (ingest-consumer.ts's outer catch blocks,
 * reached when the pipeline fails before or without ever loading the
 * source row) genuinely have no company context available -- `source`
 * there is block-scoped to the `try` and doesn't exist in `catch`.
 * `sourceId` itself is trusted, schema-validated queue data (not
 * user-facing input), so scoping by `id` alone in that specific,
 * documented case is the accepted exception here, not a silent gap:
 * every OTHER call site that does have companyId in scope should pass
 * it, and does.
 */
export async function markSourceFailure(
  client: D1Client,
  sourceId: string,
  companyId?: string,
): Promise<void> {
  if (companyId !== undefined) {
    await client.run(
      `UPDATE sources SET consecutive_failures = consecutive_failures + 1 WHERE id = ? AND company_id = ?`,
      [sourceId, companyId],
    );
    return;
  }
  await client.run(
    `UPDATE sources SET consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
    [sourceId],
  );
}

