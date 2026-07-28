import type { Message } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings";
import type { AtsProvider, IngestMessage } from "@hiring-signals/domain";
import { classifyJob, computeLifecycleTransition, computeNewJobScore } from "@hiring-signals/domain";
import { getAdapterForProvider, UnsupportedProviderError, GreenhouseSchemaError } from "@hiring-signals/adapters";
import {
  createD1Client,
  getSourceById,
  markSourceFailure,
  markSourceSuccess,
  recordSourceRunComplete,
  updateSource,
  upsertJob,
  insertJobObservation,
  getJobsMissingFromRun,
  applyLifecycleTransition,
  findActiveSignal,
  createSignal,
  refreshSignal,
  appendSignalEvidence,
  type JobRow,
} from "@hiring-signals/db";
import { computeContentHash } from "../../../../lib/text/content-hash";
import { storeRawPayload, rawPayloadKey } from "../services/raw-payload-store";

/**
 * Queue consumer (spec 5.1/13.3). For one source:
 *   fetch -> validate (adapter Zod schema) -> normalize -> upsert jobs
 *   -> insert observations -> compute lifecycle/signal transitions
 *   -> archive raw payload via services/raw-payload-store (KV, not R2)
 *      + write source_run metrics
 *
 * Must be idempotent per (sourceId, runId): a retry must not create
 * duplicate observations or duplicate signals (spec 13.3). The
 * idempotency key for job_observations is enforced at the schema level
 * (migration 0004, UNIQUE(job_id, source_run_id)) -- a retried message
 * re-inserting an observation for a (job, run) pair already recorded
 * hits that constraint and is treated as "already recorded, continue"
 * rather than a hard failure (see insertObservationIdempotent below).
 * source_runs rows are keyed by runId (resolveSourceRunId reuses the
 * same row id across retries of the same logical run).
 */

/** Max retry attempts before a failure is treated as final (spec §13.4: "e.g. 5"). */
const MAX_RETRY_ATTEMPTS = 5;

/** Capped exponential backoff for transient 5xx/timeout (spec §13.4 row 2). */
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 15 * 60;

function backoffSeconds(attempt: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempt - 1));
}

function daysBetween(laterIso: string, earlierIso: string): number {
  const ms = new Date(laterIso).getTime() - new Date(earlierIso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export async function handleIngestMessage(message: Message<IngestMessage>, env: Bindings): Promise<void> {
  const { sourceId, runId, attempt } = message.body;
  const client = createD1Client(env.DB);
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  try {
    const source = await getSourceById(client, sourceId);
    if (!source) {
      // Source was deleted/disabled between enqueue and dequeue -- not a
      // retryable condition, nothing to fetch. Ack so it doesn't loop.
      console.warn("ingest_skip_missing_source", { sourceId, runId, attempt });
      message.ack();
      return;
    }

    // source_runs row is idempotent per runId: only opened on the first
    // attempt. A retry (attempt > 1) reuses the same sourceRunId by
    // looking it up rather than opening a second row for the same run,
    // so job_observations' (job_id, source_run_id) idempotency key stays
    // meaningful across retries of the same logical run.
    const sourceRunId = await resolveSourceRunId(client, sourceId, runId, startedAt);

    let adapter;
    try {
      adapter = getAdapterForProvider(source.provider as AtsProvider);
    } catch (err) {
      if (err instanceof UnsupportedProviderError) {
        // 4xx-style configuration issue (spec §13.4 row 3): mark source
        // degraded, no automatic hammering. Not retryable -- the adapter
        // simply doesn't exist yet.
        await finalizeConfigError(client, source.id, sourceRunId, startTime, err.message);
        message.ack();
        return;
      }
      throw err;
    }

    const fetchResult = await adapter.fetchBoard(
      {
        sourceId: source.id,
        companyId: source.company_id,
        provider: source.provider as AtsProvider,
        boardToken: source.board_token,
        publicUrl: source.public_url,
      },
      { userAgent: "HiringSignalsBot/1.0 (+https://hiringsignals.example)", timeoutMs: 15_000 },
    );

    // --- Failure branches per spec §13.4, one branch each (not collapsed) ---

    if (fetchResult.httpStatus === 429) {
      const retrySeconds = fetchResult.retryAfterSeconds ?? backoffSeconds(attempt);
      await finalizeRetryable(client, source.id, sourceRunId, startTime, {
        httpStatus: fetchResult.httpStatus,
        errorCode: "rate_limited",
        errorMessageSafe: `429 Retry-After=${fetchResult.retryAfterSeconds ?? "none"}`,
      });
      await requeueOrGiveUp(message, env, sourceId, runId, attempt, retrySeconds, client, sourceRunId);
      return;
    }

    if (fetchResult.httpStatus >= 500) {
      await finalizeRetryable(client, source.id, sourceRunId, startTime, {
        httpStatus: fetchResult.httpStatus,
        errorCode: "transient_5xx",
        errorMessageSafe: `Upstream returned ${fetchResult.httpStatus}`,
      });
      await requeueOrGiveUp(
        message,
        env,
        sourceId,
        runId,
        attempt,
        backoffSeconds(attempt),
        client,
        sourceRunId,
      );
      return;
    }

    if (fetchResult.httpStatus >= 400) {
      // 4xx configuration issue: mark degraded, no automatic hammering
      // (spec §13.4 row 3) -- disable further polling until an operator
      // investigates, rather than retrying a request that will keep failing.
      await finalizeConfigError(
        client,
        source.id,
        sourceRunId,
        startTime,
        `Upstream returned ${fetchResult.httpStatus}`,
        fetchResult.httpStatus,
      );
      message.ack();
      return;
    }

    let normalizedJobs;
    try {
      normalizedJobs = adapter.normalize(fetchResult.rawBody, {
        sourceId: source.id,
        companyId: source.company_id,
        provider: source.provider as AtsProvider,
        boardToken: source.board_token,
        publicUrl: source.public_url,
      });
    } catch (err) {
      if (err instanceof GreenhouseSchemaError || isAdapterSchemaError(err)) {
        // Schema mismatch: store safe diagnostic, mark adapter warning
        // (spec §13.4 row 4) -- caught specifically so it never falls
        // through to a generic failure path.
        await finalizeConfigError(
          client,
          source.id,
          sourceRunId,
          startTime,
          `Schema mismatch: ${(err as Error).message}`,
          fetchResult.httpStatus,
          "schema_mismatch",
        );
        message.ack();
        return;
      }
      throw err;
    }

    // Archive raw payload (KV, TTL'd) before persisting derived state, so
    // even a mid-pipeline failure below leaves the raw response
    // recoverable for diagnosis.
    const payloadKey = rawPayloadKey(source.id, runId);
    await storeRawPayload(env.CACHE, source.id, runId, JSON.stringify(fetchResult.rawBody));

    const observedAt = new Date().toISOString();
    const seenExternalIds = normalizedJobs.map((j) => j.externalJobId);

    let signalsCreated = 0;

    for (const job of normalizedJobs) {
      const contentHash = await computeContentHash({
        title: job.title,
        descriptionText: job.descriptionText ?? null,
        department: job.department ?? null,
        employmentType: job.employmentType ?? null,
        locationRaw: job.locationRaw ?? null,
      });

      const existing = await client.first<Pick<JobRow, "id" | "status" | "missing_run_count" | "first_seen_at">>(
        `SELECT id, status, missing_run_count, first_seen_at FROM jobs WHERE source_id = ? AND external_job_id = ?`,
        [source.id, job.externalJobId],
      );

      const jobId = await upsertJob(client, {
        sourceId: source.id,
        companyId: source.company_id,
        externalJobId: job.externalJobId,
        canonicalUrl: job.canonicalUrl,
        title: job.title,
        titleNormalized: job.title.toLowerCase(),
        descriptionText: job.descriptionText,
        department: job.department,
        employmentType: job.employmentType,
        locationRaw: job.locationRaw,
        locationMode: job.locationMode,
        postedAt: job.postedAt,
        sourceUpdatedAt: job.updatedAt,
        contentHash,
        observedAt,
      });

      await insertObservationIdempotent(client, {
        jobId,
        sourceRunId,
        observedAt,
        contentHash,
        isPresent: true,
      });

      const lifecycle = computeLifecycleTransition({
        currentState: existing?.status as "active" | "possibly_closed" | "closed" | undefined,
        wasPresentThisRun: true,
        consecutiveMissingRuns: existing?.missing_run_count ?? 0,
        daysSinceLastSeen: 0,
      });

      await applyLifecycleTransition(client, jobId, {
        status: lifecycle.nextState,
        missingRunCount: lifecycle.nextConsecutiveMissingRuns,
        lastSeenAt: observedAt,
      });

      if (lifecycle.candidateSignal === "new_job" || lifecycle.candidateSignal === "reopened_job") {
        const classification = classifyJob({
          title: job.title,
          department: job.department,
          descriptionText: job.descriptionText,
        });

        await client.run(
          `UPDATE jobs SET role_primary = ?, classification_confidence = ?, classification_version = ? WHERE id = ?`,
          [
            classification.rolePrimary ?? null,
            classification.confidence,
            classification.classificationVersion,
            jobId,
          ],
        );

        // Signal generation only for auto-classified jobs (spec §6.2 step
        // 7: below-threshold jobs are still stored but not surfaced as
        // signals yet -- classification_confidence < 0.80 means role
        // assignment isn't trustworthy enough to drive a scored signal).
        if (classification.autoClassified && classification.rolePrimary) {
          const daysSinceObservation = 0; // freshly observed this run
          const scoreResult = computeNewJobScore({
            daysSinceObservation,
            classificationConfidence: classification.confidence,
          });

          const activeSignal = await findActiveSignal(client, {
            companyId: source.company_id,
            roleCategory: classification.rolePrimary,
            signalType: lifecycle.candidateSignal,
          });

          let signalId: string;
          if (activeSignal) {
            signalId = activeSignal.id;
            await refreshSignal(client, signalId, {
              score: scoreResult.score,
              scoreVersion: scoreResult.formulaVersion,
              lastDetectedAt: observedAt,
            });
          } else {
            signalId = await createSignal(client, {
              companyId: source.company_id,
              roleCategory: classification.rolePrimary,
              signalType: lifecycle.candidateSignal,
              score: scoreResult.score,
              scoreVersion: scoreResult.formulaVersion,
              detectedAt: observedAt,
              headline: buildHeadline(lifecycle.candidateSignal, job.title),
              summary: buildSummary(lifecycle.candidateSignal, job.title),
            });
            signalsCreated++;
          }

          await appendSignalEvidence(client, {
            signalId,
            jobId,
            evidenceType: lifecycle.candidateSignal,
            observedAt,
            payload: scoreResult,
          });
        }
      }
    }

    // Complement: jobs previously active/possibly_closed for this source
    // that were NOT seen this run -- lifecycle transition for absence
    // (spec §5.4 rows 3-5), one round trip via getJobsMissingFromRun.
    const missingJobs = await getJobsMissingFromRun(client, source.id, seenExternalIds);
    for (const missingJob of missingJobs) {
      const daysSinceLastSeen = daysBetween(observedAt, missingJob.last_seen_at);
      const lifecycle = computeLifecycleTransition({
        currentState: missingJob.status as "active" | "possibly_closed" | "closed",
        wasPresentThisRun: false,
        consecutiveMissingRuns: missingJob.missing_run_count,
        daysSinceLastSeen,
      });

      await applyLifecycleTransition(client, missingJob.id, {
        status: lifecycle.nextState,
        missingRunCount: lifecycle.nextConsecutiveMissingRuns,
      });

      await insertObservationIdempotent(client, {
        jobId: missingJob.id,
        sourceRunId,
        observedAt,
        contentHash: missingJob.content_hash,
        isPresent: false,
      });
    }

    const nextPollAt = computeNextPollAt(source.poll_interval_minutes, source.id);
    await markSourceSuccess(client, source.id, nextPollAt);

    const durationMs = Date.now() - startTime;
    await recordSourceRunComplete(client, sourceRunId, {
      completedAt: new Date().toISOString(),
      status: "success",
      httpStatus: fetchResult.httpStatus,
      jobsReceived: normalizedJobs.length,
      jobsNormalized: normalizedJobs.length,
      rawPayloadKey: payloadKey,
      durationMs,
    });

    // Facets KV cache (apps/api/src/routes/facets.ts) has a 60s TTL and
    // is allowed to expire naturally per ROADMAP.md Milestone D -- no
    // explicit invalidation call here, the spec doesn't require
    // sub-60s propagation.

    // console.warn (not console.log): this repo's eslint config only
    // allows warn/error console methods, and structured operational logs
    // (success included) use that same channel, matching the existing
    // ingest_stub/ingest_failed convention this file replaced.
    console.warn("ingest_success", {
      sourceId: source.id,
      provider: source.provider,
      runId,
      httpStatus: fetchResult.httpStatus,
      durationMs,
      jobsReceived: normalizedJobs.length,
      jobsNormalized: normalizedJobs.length,
      signalsCreated,
    });

    message.ack();
  } catch (err) {

    // D1/KV transient error or any other uncaught failure: retry,
    // preserve idempotency (spec §13.4 row 6) -- everything above already
    // uses idempotent writes (ON CONFLICT upsert, UNIQUE-constrained
    // observations), so a retry from the top is safe.
    console.error("ingest_failed", {
      sourceId,
      runId,
      attempt,
      errorCode: "uncaught",
      message: (err as Error)?.message,
    });

    if (attempt >= MAX_RETRY_ATTEMPTS) {
      // Retry exhaustion -> persistent failure record for human review
      // (spec §13.4: "a persistent failure table with a human-review
      // workflow" -- a source_runs row with status='failed_final' is
      // sufficient for v1, per ROADMAP.md Milestone D).
      try {
        const client2 = createD1Client(env.DB);
        const sourceRunId2 = await resolveSourceRunId(client2, sourceId, runId, startedAt);
        await recordSourceRunComplete(client2, sourceRunId2, {
          completedAt: new Date().toISOString(),
          status: "failed_final",
          errorCode: "retry_exhausted",
          errorMessageSafe: (err as Error)?.message ?? "unknown error",
          durationMs: Date.now() - startTime,
        });
        await markSourceFailure(client2, sourceId);
      } catch (finalizeErr) {
        console.error("ingest_finalize_failed", { sourceId, runId, message: (finalizeErr as Error)?.message });
      }
      message.ack(); // stop retrying; failure is recorded for review
      return;
    }

    message.retry();
  }
}

/**
 * Opens (attempt=1) or reuses (attempt>1) the source_runs row for this
 * runId, so retries of the same logical run share one row instead of
 * each attempt creating a new one -- keeps job_observations' (job_id,
 * source_run_id) idempotency key meaningful across retries.
 *
 * source_runs.id is the primary key; this reuses the queue message's own
 * runId as that primary key instead of generating a second id, so "same
 * runId" and "same source_runs row" are the same fact, checkable by a
 * single lookup on retry.
 */
async function resolveSourceRunId(
  client: ReturnType<typeof createD1Client>,
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
 * Insert a job_observation, treating a UNIQUE(job_id, source_run_id)
 * constraint violation (migration 0004) as "already recorded by a prior
 * attempt of this same run" rather than a hard failure -- the idempotency
 * contract spec §13.3 requires.
 */
async function insertObservationIdempotent(
  client: ReturnType<typeof createD1Client>,
  input: Parameters<typeof insertJobObservation>[1],
): Promise<void> {
  try {
    await insertJobObservation(client, input);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return; // already recorded this (job, run) pair -- idempotent no-op
    }
    throw err;
  }
}

function isAdapterSchemaError(err: unknown): boolean {
  return err instanceof Error && err.name.endsWith("SchemaError");
}

async function finalizeConfigError(
  client: ReturnType<typeof createD1Client>,
  sourceId: string,
  sourceRunId: string,
  startTime: number,
  message: string,
  httpStatus?: number,
  errorCode = "config_error",
): Promise<void> {
  await recordSourceRunComplete(client, sourceRunId, {
    completedAt: new Date().toISOString(),
    status: "failed",
    httpStatus,
    errorCode,
    errorMessageSafe: message,
    durationMs: Date.now() - startTime,
  });
  // "Mark source degraded" (spec §13.4): disable further automatic
  // polling until an operator investigates via the ops script, rather
  // than repeatedly hammering an endpoint that will keep failing the
  // same way.
  await updateSource(client, sourceId, { enabled: false });
  await markSourceFailure(client, sourceId);
}

async function finalizeRetryable(
  client: ReturnType<typeof createD1Client>,
  sourceId: string,
  sourceRunId: string,
  startTime: number,
  input: { httpStatus: number; errorCode: string; errorMessageSafe: string },
): Promise<void> {
  await recordSourceRunComplete(client, sourceRunId, {
    completedAt: new Date().toISOString(),
    status: "failed",
    httpStatus: input.httpStatus,
    errorCode: input.errorCode,
    errorMessageSafe: input.errorMessageSafe,
    durationMs: Date.now() - startTime,
  });
  await markSourceFailure(client, sourceId);
}

/**
 * Requeues with a Queue-level delay for retryable failures (429, transient
 * 5xx), or gives up and records a final failure once MAX_RETRY_ATTEMPTS is
 * reached -- spec §13.4: "After exhaustion, send to a dead-letter queue or
 * persistent failure table." A source_runs row with status='failed_final'
 * is the v1 persistent-failure record; a formal dead-letter queue can wait
 * for real failure volume (ROADMAP.md Milestone D).
 *
 * Cloudflare Queues' native retry() doesn't accept a custom delay, so a
 * capped-backoff retry re-enqueues a fresh message with the same
 * sourceId+runId+incremented attempt instead, using delaySeconds on the
 * producer send -- this keeps idempotency (same runId) while honoring
 * 429's Retry-After / exponential backoff timing that message.retry()
 * alone can't express.
 */
async function requeueOrGiveUp(
  message: Message<IngestMessage>,
  env: Bindings,
  sourceId: string,
  runId: string,
  attempt: number,
  delaySeconds: number,
  client: ReturnType<typeof createD1Client>,
  sourceRunId: string,
): Promise<void> {
  if (attempt >= MAX_RETRY_ATTEMPTS) {
    await recordSourceRunComplete(client, sourceRunId, {
      completedAt: new Date().toISOString(),
      status: "failed_final",
      errorCode: "retry_exhausted",
      errorMessageSafe: `Gave up after ${attempt} attempts`,
    });
    message.ack();
    return;
  }

  const nextMessage: IngestMessage = {
    version: 1,
    sourceId,
    runId,
    requestedAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    attempt: attempt + 1,
  };
  await env.INGEST_QUEUE.send(nextMessage, { delaySeconds });
  message.ack(); // ack the current message; the re-enqueued one carries the retry forward
}

/**
 * next_poll_at = now + poll_interval_minutes, with the same deterministic
 * per-source jitter the scheduler uses (spec §5.2) so a source's actual
 * poll cadence stays spread out run over run, not just on its first
 * enqueue.
 */
function computeNextPollAt(pollIntervalMinutes: number, sourceId: string): string {
  let hash = 0;
  for (let i = 0; i < sourceId.length; i++) {
    hash = (hash * 31 + sourceId.charCodeAt(i)) >>> 0;
  }
  const jitterSeconds = hash % 600; // matches scheduler.ts's JITTER_SPREAD_SECONDS
  const ms = Date.now() + pollIntervalMinutes * 60_000 + jitterSeconds * 1000;
  return new Date(ms).toISOString();
}

function buildHeadline(signalType: "new_job" | "reopened_job", jobTitle: string): string {
  return signalType === "new_job" ? `New role: ${jobTitle}` : `Reopened: ${jobTitle}`;
}

function buildSummary(signalType: "new_job" | "reopened_job", jobTitle: string): string {
  return signalType === "new_job"
    ? `A new job posting was detected: "${jobTitle}".`
    : `A previously closed job posting reappeared: "${jobTitle}".`;
}
