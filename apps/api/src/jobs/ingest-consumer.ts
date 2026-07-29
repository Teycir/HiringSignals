import type { Message } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings";
import type {
  AtsProvider,
  IngestMessage,
  LocationMode,
  NormalizedJob,
  RoleCategory,
  SignalType,
} from "@hiring-signals/domain";
import {
  atsProviderSchema,
  classifyJob,
  computeLifecycleTransition,
  computeNewJobScore,
  buildJobEmbeddingText,
} from "@hiring-signals/domain";
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
  getJobByExternalId,
  getJobsMissingFromRun,
  applyLifecycleTransition,
  updateJobClassification,
  resolveSourceRun,
  findActiveSignal,
  createSignal,
  refreshSignal,
  appendSignalEvidence,
  getCompanyRoleActivityStats,
  type SourceRow,
} from "@hiring-signals/db";
import { computeContentHash } from "../../../../lib/text/content-hash";
import { isUniqueConstraintError } from "../../../../lib/d1/unique-constraint";
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
 * source_runs rows are keyed by runId (resolveSourceRun, packages/db,
 * reuses the same row id across retries of the same logical run).
 *
 * File structure (code-review P1 finding, 2026-07-28: this file was a
 * single 359-line function mixing 7 pipeline stages with 3 inline SQL
 * queries that bypassed the repo layer -- see git history for the prior
 * shape). Now split into named stages so each can be read and tested in
 * isolation: resolveProvider -> fetch/validate branches (still inline in
 * handleIngestMessage, since each one's ack/retry decision is genuinely
 * part of the message-handling control flow, not pipeline logic) ->
 * processNormalizedJob (per-job upsert/observation/lifecycle/
 * classification/signal) -> processMissingJobs (the absence complement).
 * All 3 inline SQL queries the review flagged (job lookup by external
 * id, classification UPDATE, source_runs resolve/insert) now live in
 * packages/db/src/jobs-repo.ts and sources-repo.ts instead, so a future
 * column rename breaks `pnpm --filter db test`, not a query string
 * hidden in apps/api.
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

/**
 * A caught error's message, safe to log/persist. Guards with
 * `instanceof Error` instead of an `as Error` cast (code-review P2
 * finding) -- a catch binding in JS can be any thrown value (`throw 42`,
 * `throw "oops"`), and a bare cast would silently produce `undefined` in
 * the log for a non-Error throw instead of surfacing what was actually
 * thrown.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Distinguishes a transient/infrastructure failure (worth retrying) from
 * a programmer bug (not worth retrying 5x against a live pipeline).
 * Code-review P1 finding: the prior version's outer catch retried
 * *everything* uncaught, including a `TypeError` from a typo, up to
 * MAX_RETRY_ATTEMPTS times -- each retry re-hits the ATS endpoint,
 * re-archives the payload to KV, and re-runs the pipeline, so a code bug
 * silently produced a 5x traffic spike against upstream and 5 log lines
 * that look like infrastructure flakiness instead of one clear "this is
 * broken" signal.
 *
 * Deliberately conservative: only classifies well-known JS "this is a
 * bug in our code" error constructors as non-transient. Everything else
 * (D1 errors, network errors, a plain `Error` thrown by a dependency)
 * is treated as transient and retried, matching spec §13.4 row 6's
 * "D1/KV transient error or any other uncaught failure: retry, preserve
 * idempotency" -- this function only carves out the specific classes the
 * spec's own retry policy was never meant to cover.
 */
function isProgrammerError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  );
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
    const sourceRunId = await resolveSourceRun(client, sourceId, runId, startedAt);

    // Validate the DB's provider string against the domain enum instead
    // of an `as AtsProvider` cast (code-review P2 finding). Previously
    // this cast happened 3x and "worked" only because
    // getAdapterForProvider happened to throw UnsupportedProviderError
    // for an invalid string, which the catch below happened to handle --
    // correct by accident, not by a checked guarantee at this call site.
    const providerResult = atsProviderSchema.safeParse(source.provider);
    if (!providerResult.success) {
      await finalizeConfigError(
        client,
        source.id,
        sourceRunId,
        startTime,
        `Invalid provider="${source.provider}" in DB row`,
      );
      message.ack();
      return;
    }
    const provider = providerResult.data;

    let adapter;
    try {
      adapter = getAdapterForProvider(provider);
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
        provider,
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
        provider,
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
          `Schema mismatch: ${errorMessage(err)}`,
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
      signalsCreated += await processNormalizedJob(client, env, source, sourceRunId, job, observedAt);
    }

    signalsCreated += await processMissingJobs(client, source, sourceRunId, seenExternalIds, observedAt);

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
    // Programmer bugs (TypeError/ReferenceError/RangeError/SyntaxError)
    // fail fast with a single finalize + ack instead of retrying 5x
    // against a live pipeline (code-review P1 finding -- see
    // isProgrammerError's header comment for the full reasoning).
    // Everything else (D1/KV transient error or any other uncaught
    // failure) retries with idempotency preserved, per spec §13.4 row 6
    // -- everything above already uses idempotent writes (ON CONFLICT
    // upsert, UNIQUE-constrained observations), so a retry from the top
    // is safe.
    const message_ = errorMessage(err);

    if (isProgrammerError(err)) {
      console.error("ingest_programmer_error", {
        sourceId,
        runId,
        attempt,
        errorCode: "programmer_error",
        errorName: err instanceof Error ? err.name : typeof err,
        message: message_,
      });
      try {
        const client2 = createD1Client(env.DB);
        const sourceRunId2 = await resolveSourceRun(client2, sourceId, runId, startedAt);
        await recordSourceRunComplete(client2, sourceRunId2, {
          completedAt: new Date().toISOString(),
          status: "failed_final",
          errorCode: "programmer_error",
          errorMessageSafe: message_,
          durationMs: Date.now() - startTime,
        });
        await markSourceFailure(client2, sourceId);
      } catch (finalizeErr) {
        console.error("ingest_finalize_failed", { sourceId, runId, message: errorMessage(finalizeErr) });
      }
      message.ack(); // not retryable -- retrying won't fix a code bug
      return;
    }

    console.error("ingest_failed", {
      sourceId,
      runId,
      attempt,
      errorCode: "uncaught",
      message: message_,
    });

    if (attempt >= MAX_RETRY_ATTEMPTS) {
      // Retry exhaustion -> persistent failure record for human review
      // (spec §13.4: "a persistent failure table with a human-review
      // workflow" -- a source_runs row with status='failed_final' is
      // sufficient for v1, per ROADMAP.md Milestone D).
      try {
        const client2 = createD1Client(env.DB);
        const sourceRunId2 = await resolveSourceRun(client2, sourceId, runId, startedAt);
        await recordSourceRunComplete(client2, sourceRunId2, {
          completedAt: new Date().toISOString(),
          status: "failed_final",
          errorCode: "retry_exhausted",
          errorMessageSafe: message_,
          durationMs: Date.now() - startTime,
        });
        await markSourceFailure(client2, sourceId);
      } catch (finalizeErr) {
        console.error("ingest_finalize_failed", { sourceId, runId, message: errorMessage(finalizeErr) });
      }
      message.ack(); // stop retrying; failure is recorded for review
      return;
    }

    message.retry();
  }
}

/** hiring_burst trigger threshold (spec §7.1's literal trigger table). */
const HIRING_BURST_MIN_NEW_IN_14_DAYS = 3;
/** multi_location trigger threshold (spec §7.1's literal trigger table; same 3 as computeBreadth's saturation point). */
const MULTI_LOCATION_MIN_DISTINCT_LOCATIONS = 3;
/** role_acceleration trigger cutoff on H.3's acceleration component (0-1). Documented v1 choice, not spec-derived -- same caveat as computeVolume's VOLUME_SCALE=5 (ROADMAP.md H.4). Deliberately above the formula's own cold-start value: with zero prior-56-day history, computeAcceleration's max(2, priorRate) floor means a single newly observed job already scores exactly 0.5 (1/2) and two jobs saturate to 1.0 -- a >=0.5 cutoff would flag every brand-new company+role pair as "accelerating" on its very first job, which isn't a meaningful signal. 0.75 requires more than one bare job's worth of cold-start momentum before triggering. */
const ROLE_ACCELERATION_MIN_COMPONENT = 0.75;
/** persistent_demand trigger threshold in days (spec §7.1's literal trigger table). */
const PERSISTENT_DEMAND_MIN_DAYS_ACTIVE = 30;

/**
 * H.4: company-level/secondary signal generation (hiring_burst,
 * role_acceleration, multi_location, persistent_demand -- spec §7.1,
 * §1.4). Runs once per job, immediately after the primary new_job/
 * reopened_job signal has been created/refreshed above, reusing that
 * same H.2 activityStats fetch (no extra D1 round trip) plus H.3's
 * already-computed acceleration component. Each of the four is
 * independent -- a single job can trigger any subset of them (e.g. a
 * job that's both the 3rd-in-14-days AND the 3rd distinct location
 * triggers both hiring_burst and multi_location).
 *
 * persistent_demand is the one exception needing its own D1 read: its
 * condition (`>= 30 days since first_detected_at, continuously active`)
 * depends on the primary new_job/reopened_job signal's own
 * first_detected_at, which is only known post-write (activeSignal's
 * existing row, or the freshly created one's detectedAt if this is the
 * very first occurrence -- a brand-new signal is 0 days old, so it can
 * never itself satisfy the >=30 day threshold on its first write, but
 * checking the freshly-created case explicitly keeps the logic uniform
 * rather than special-casing "must already exist").
 */
async function generateCompanySignals(
  client: ReturnType<typeof createD1Client>,
  source: Pick<SourceRow, "company_id">,
  roleCategory: Parameters<typeof findActiveSignal>[1]["roleCategory"],
  activityStats: Awaited<ReturnType<typeof getCompanyRoleActivityStats>>,
  accelerationComponent: number,
  primarySignalFirstDetectedAt: string,
  primaryScore: number,
  primaryScoreVersion: string,
  jobId: string,
  jobTitle: string,
  observedAt: string,
): Promise<number> {
  const triggered: SignalType[] = [];
  if (activityStats.newInLast14Days >= HIRING_BURST_MIN_NEW_IN_14_DAYS) {
    triggered.push("hiring_burst");
  }
  if (activityStats.distinctLocationCount >= MULTI_LOCATION_MIN_DISTINCT_LOCATIONS) {
    triggered.push("multi_location");
  }
  if (accelerationComponent >= ROLE_ACCELERATION_MIN_COMPONENT) {
    triggered.push("role_acceleration");
  }
  const daysActive = daysBetween(observedAt, primarySignalFirstDetectedAt);
  if (daysActive >= PERSISTENT_DEMAND_MIN_DAYS_ACTIVE) {
    triggered.push("persistent_demand");
  }

  let signalsCreated = 0;
  for (const signalType of triggered) {
    const activeSignal = await findActiveSignal(client, {
      companyId: source.company_id,
      roleCategory,
      signalType,
    });

    let signalId: string;
    if (activeSignal) {
      signalId = activeSignal.id;
      // Company-level signals don't have their own independent score
      // formula yet (spec §7.1 defines triggers, not a distinct scoring
      // function per type) -- reuse the primary new_job/reopened_job
      // signal's freshly computed score (H.3) as a stand-in, refreshed
      // alongside it. Revisit once a dedicated company-level scoring
      // pass exists.
      await refreshSignal(client, signalId, {
        score: primaryScore,
        scoreVersion: primaryScoreVersion,
        lastDetectedAt: observedAt,
      });
    } else {
      signalId = await createSignal(client, {
        companyId: source.company_id,
        roleCategory,
        signalType,
        score: primaryScore,
        scoreVersion: primaryScoreVersion,
        detectedAt: observedAt,
        headline: buildHeadline(signalType, jobTitle),
        summary: buildSummary(signalType, jobTitle),
      });
      signalsCreated += 1;
    }

    await appendSignalEvidence(client, {
      signalId,
      jobId,
      evidenceType: signalType,
      observedAt,
      payload: {
        signalType,
        activeMatchingCount: activityStats.activeMatchingCount,
        newInLast14Days: activityStats.newInLast14Days,
        newInPrior56Days: activityStats.newInPrior56Days,
        distinctLocationCount: activityStats.distinctLocationCount,
        accelerationComponent,
        daysActive,
      },
    });
  }

  return signalsCreated;
}

/**
 * One job's slice of the pipeline: upsert -> observation -> lifecycle
 * transition -> classification -> signal generation. Extracted from
 * handleIngestMessage's per-job loop (code-review P1 finding -- the
 * original was a 359-line function; this is the largest single stage of
 * it, worth naming and testing on its own). Returns 1 if a new signal
 * was created for this job, 0 otherwise, so the caller can accumulate
 * signalsCreated across the loop without this function needing to know
 * about logging.
 */
async function processNormalizedJob(
  client: ReturnType<typeof createD1Client>,
  ai: Pick<Bindings, "AI" | "VECTORIZE" | "EMBEDDING_MODEL">,
  source: Pick<SourceRow, "id" | "company_id">,
  sourceRunId: string,
  job: NormalizedJob,
  observedAt: string,
): Promise<number> {
  const contentHash = await computeContentHash({
    title: job.title,
    descriptionText: job.descriptionText ?? null,
    department: job.department ?? null,
    employmentType: job.employmentType ?? null,
    locationRaw: job.locationRaw ?? null,
  });

  const existing = await getJobByExternalId(client, source.id, job.externalJobId);

  const upsertResult = await upsertJob(client, {
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
  const jobId = upsertResult.id;

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

  // I.2: embed-and-upsert into Vectorize, gated on "this job is new or
  // its content actually changed" -- an unchanged job on a re-scrape
  // would otherwise re-embed identical text on every ingest run for no
  // benefit. Placed here (before the new/reopened-signal branch below)
  // rather than after scoring, because the gate is about content
  // change, not about whether this run produced a scored signal: a
  // content edit on a job with no active signal still deserves an
  // updated embedding even though it returns 0 signals below.
  if (!existing || upsertResult.contentChanged) {
    await embedAndUpsertJob(ai, {
      jobId,
      companyId: source.company_id,
      status: lifecycle.nextState,
      postedAt: job.postedAt ?? existing?.first_seen_at ?? observedAt,
      // existing?.role_primary: the job's prior classification, if any --
      // a brand-new job hasn't been classified yet at this point in the
      // function (classification happens further down, only on the
      // new/reopened path), so its first embedding simply omits
      // roleCategory rather than blocking on classification.
      roleCategory: existing?.role_primary as RoleCategory | null | undefined,
      locationMode: job.locationMode,
      titleRaw: job.title,
      departmentRaw: job.department,
      locationRaw: job.locationRaw,
      descriptionText: job.descriptionText,
    });
  }

  if (lifecycle.candidateSignal !== "new_job" && lifecycle.candidateSignal !== "reopened_job") {
    // Not a new/reopened job this run, but the listing's content may
    // still have changed (title/description/department/employment
    // type/location -- whatever upsertJob's content_hash comparison
    // covers). A relaxed requirement, a remote->onsite flip, etc. on a
    // role we're already tracking is itself meaningful evidence (F4),
    // distinct from and cheaper than a full re-score: only recorded when
    // there's an existing active signal for this (company, role) to
    // attach it to -- a content edit on a job with no active signal has
    // nothing to provide evidence *for* yet.
    if (upsertResult.contentChanged && existing?.role_primary) {
      const activeSignalForEdit = await findActiveSignal(client, {
        companyId: source.company_id,
        // role_primary is stored as TEXT in D1 (JobRow's `string | null`)
        // but is always written from RoleCategory by updateJobClassification
        // -- same cast pattern this file already uses for existing?.status.
        roleCategory: existing.role_primary as Parameters<typeof findActiveSignal>[1]["roleCategory"],
        signalType: "new_job",
      });
      if (activeSignalForEdit) {
        await appendSignalEvidence(client, {
          signalId: activeSignalForEdit.id,
          jobId,
          evidenceType: "job_updated",
          observedAt,
          payload: { contentHash },
        });
      }
    }
    return 0;
  }

  const classification = classifyJob({
    title: job.title,
    department: job.department,
    descriptionText: job.descriptionText,
  });

  await updateJobClassification(client, jobId, {
    rolePrimary: classification.rolePrimary ?? null,
    classificationConfidence: classification.confidence,
    classificationVersion: classification.classificationVersion,
  });

  // Signal generation only for auto-classified jobs (spec §6.2 step 7:
  // below-threshold jobs are still stored but not surfaced as signals
  // yet -- classification_confidence < 0.80 means role assignment isn't
  // trustworthy enough to drive a scored signal).
  if (!classification.autoClassified || !classification.rolePrimary) {
    return 0;
  }

  // Freshness (R) must reflect how old the *job listing* is, not how
  // recently we happened to scrape it (spec 7.2: "days since the job's
  // posting/most recent evidence observation"). Anchor on the adapter's
  // postedAt when the source provides it; otherwise fall back to
  // first_seen_at (our own earliest observation of this job) so a job
  // whose source omits postedAt still ages normally instead of always
  // scoring as brand-new.
  const anchorDate = job.postedAt ?? existing?.first_seen_at ?? observedAt;
  const daysSinceObservation = Math.max(
    0,
    (new Date(observedAt).getTime() - new Date(anchorDate).getTime()) / 86_400_000,
  );

  // H.3: real V/A/B inputs, fetched once per job via H.2's shared stats
  // query (company_id + the just-classified role_primary), replacing the
  // v1 fixed-0.5 neutral constant. Also reused by H.4's company-level
  // signal triggers below -- one D1 round trip serves both.
  const activityStats = await getCompanyRoleActivityStats(client, {
    companyId: source.company_id,
    roleCategory: classification.rolePrimary,
    now: observedAt,
  });

  const scoreResult = computeNewJobScore({
    daysSinceObservation,
    classificationConfidence: classification.confidence,
    activeMatchingCount: activityStats.activeMatchingCount,
    newInLast14Days: activityStats.newInLast14Days,
    newInPrior56Days: activityStats.newInPrior56Days,
    distinctLocationCount: activityStats.distinctLocationCount,
  });

  const activeSignal = await findActiveSignal(client, {
    companyId: source.company_id,
    roleCategory: classification.rolePrimary,
    signalType: lifecycle.candidateSignal,
  });

  let signalId: string;
  let createdNewSignal = 0;
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
    createdNewSignal = 1;
  }

  await appendSignalEvidence(client, {
    signalId,
    jobId,
    evidenceType: lifecycle.candidateSignal,
    observedAt,
    payload: scoreResult,
  });

  // H.4: company-level/secondary signals (hiring_burst, role_acceleration,
  // multi_location, persistent_demand). Reuses activityStats (H.2) and
  // scoreResult.components.acceleration (H.3) already computed above --
  // no extra D1 round trip for the trigger checks themselves.
  // primarySignalFirstDetectedAt: the existing row's first_detected_at
  // when refreshing, or observedAt itself when this is a brand-new
  // signal (0 days old -- can't satisfy persistent_demand's >=30 day
  // threshold yet, but daysBetween(observedAt, observedAt) correctly
  // evaluates to 0 rather than needing a separate branch).
  const primarySignalFirstDetectedAt = activeSignal?.first_detected_at ?? observedAt;
  const companySignalsCreated = await generateCompanySignals(
    client,
    source,
    classification.rolePrimary,
    activityStats,
    scoreResult.components.acceleration,
    primarySignalFirstDetectedAt,
    scoreResult.score,
    scoreResult.formulaVersion,
    jobId,
    job.title,
    observedAt,
  );

  return createdNewSignal + companySignalsCreated;
}

/** Fields embedAndUpsertJob needs, decoupled from any one caller's exact row shape (mirrors JobEmbeddingInput's own reasoning in embedding-text.ts). */
interface EmbedJobParams {
  jobId: string;
  companyId: string;
  status: "active" | "possibly_closed" | "closed";
  /** ISO-8601. Same anchorDate fallback chain the caller already uses for freshness scoring (job.postedAt -> existing.first_seen_at -> observedAt), so the metadata value is never left undefined even for a job whose source omits postedAt. */
  postedAt: string;
  roleCategory?: RoleCategory | null;
  locationMode?: LocationMode;
  titleRaw: string;
  departmentRaw?: string;
  locationRaw?: string;
  descriptionText?: string;
}

/**
 * Embed a job's text via Workers AI and upsert the resulting vector into
 * Vectorize, keyed on the job's own D1 primary key (spec §9.4, Milestone
 * I.2) -- mirrors ArxivExplorer's "vector ID = bare arXiv ID" choice, so
 * a later query-time hit maps straight back to a jobs row with no
 * separate id-mapping table. VECTORIZE.upsert is confirmed idempotent on
 * vector ID per Cloudflare's current Vectorize docs (an upsert with an
 * existing id replaces its values/metadata rather than duplicating the
 * vector), so a retried queue message that re-embeds the same job is
 * safe by construction -- no extra dedup logic needed here.
 *
 * Deliberately NOT a hard dependency for ingestion (spec's I.5
 * guardrail, applied here one milestone early): embedding is best-effort
 * and MUST NOT throw out of this function. A Workers AI or Vectorize
 * outage means this job stays fully ingested/classified/scored, just not
 * semantically searchable until a later backfill (I.3) picks it up --
 * this is a deliberate asymmetry from spec §13.4's ATS-fetch failure
 * handling (which does retry the whole message), because losing an
 * embedding loses nothing a job already has, while losing an ATS fetch
 * loses the job's data entirely.
 */
async function embedAndUpsertJob(
  ai: Pick<Bindings, "AI" | "VECTORIZE" | "EMBEDDING_MODEL">,
  params: EmbedJobParams,
): Promise<void> {
  try {
    const text = buildJobEmbeddingText({
      titleRaw: params.titleRaw,
      rolePrimary: params.roleCategory,
      departmentRaw: params.departmentRaw,
      locationRaw: params.locationRaw,
      descriptionText: params.descriptionText,
    });

    const embeddingResult = await ai.AI.run(
      ai.EMBEDDING_MODEL as "@cf/baai/bge-base-en-v1.5",
      { text: [text] },
    );

    if (!("data" in embeddingResult) || !embeddingResult.data?.[0]) {
      // Async-batch response shape (request_id, no data yet) -- shouldn't
      // happen for a single-text, non-queued run() call, but narrowing
      // here keeps this function's own types honest rather than casting
      // past a shape run() itself says is possible.
      console.error(`Embedding skipped for job ${params.jobId}: no embedding data returned`);
      return;
    }

    const metadata: Record<string, VectorizeVectorMetadata> = {
      companyId: params.companyId,
      status: params.status,
      postedAt: params.postedAt,
    };
    if (params.roleCategory) {
      metadata.roleCategory = params.roleCategory;
    }
    if (params.locationMode) {
      metadata.locationMode = params.locationMode;
    }

    await ai.VECTORIZE.upsert([
      {
        id: params.jobId,
        values: embeddingResult.data[0],
        metadata,
      },
    ]);
  } catch (error) {
    // Log-and-continue, never throw: see this function's doc comment for
    // why an embedding failure must not fail the enclosing ingest
    // message/job processing.
    console.error(`Embedding failed for job ${params.jobId}:`, error);
  }
}

/**
 * The absence complement: jobs previously active/possibly_closed for
 * this source that were NOT seen this run -- lifecycle transition for
 * absence (spec §5.4 rows 3-5), one round trip via getJobsMissingFromRun.
 * Extracted from handleIngestMessage's second loop (code-review P1
 * finding, same reasoning as processNormalizedJob above). Always returns
 * 0 for signalsCreated -- an absence never creates a signal on its own,
 * kept as a return value only so the caller's accumulation pattern
 * (`signalsCreated += ...`) stays uniform between both stages.
 */
async function processMissingJobs(
  client: ReturnType<typeof createD1Client>,
  source: Pick<SourceRow, "id">,
  sourceRunId: string,
  seenExternalIds: string[],
  observedAt: string,
): Promise<number> {
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
  return 0;
}

/**
 * Insert a job_observation, treating a UNIQUE(job_id, source_run_id)
 * constraint violation (migration 0004) as "already recorded by a prior
 * attempt of this same run" rather than a hard failure -- the idempotency
 * contract spec §13.3 requires. Uses the shared isUniqueConstraintError
 * helper (lib/d1/unique-constraint.ts) rather than its own inline regex
 * copy -- code review flagged this as the third of three near-identical
 * copies (the other two, in sources-repo.ts/companies-repo.ts, were
 * already centralized) and this was the one left behind.
 */
async function insertObservationIdempotent(
  client: ReturnType<typeof createD1Client>,
  input: Parameters<typeof insertJobObservation>[1],
): Promise<void> {
  try {
    await insertJobObservation(client, input);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
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

function buildHeadline(signalType: SignalType, jobTitle: string): string {
  switch (signalType) {
    case "new_job":
      return `New role: ${jobTitle}`;
    case "reopened_job":
      return `Reopened: ${jobTitle}`;
    case "hiring_burst":
      return `Hiring burst: ${jobTitle}`;
    case "role_acceleration":
      return `Accelerating hiring: ${jobTitle}`;
    case "multi_location":
      return `Multi-location hiring: ${jobTitle}`;
    case "persistent_demand":
      return `Persistent demand: ${jobTitle}`;
  }
}

function buildSummary(signalType: SignalType, jobTitle: string): string {
  switch (signalType) {
    case "new_job":
      return `A new job posting was detected: "${jobTitle}".`;
    case "reopened_job":
      return `A previously closed job posting reappeared: "${jobTitle}".`;
    case "hiring_burst":
      return `Three or more new postings for this role were detected in the last 14 days, most recently "${jobTitle}".`;
    case "role_acceleration":
      return `The pace of new postings for this role has increased notably, most recently "${jobTitle}".`;
    case "multi_location":
      return `This role is now actively posted across three or more distinct locations, most recently "${jobTitle}".`;
    case "persistent_demand":
      return `This role has stayed continuously active for 30+ days, most recently "${jobTitle}".`;
  }
}
