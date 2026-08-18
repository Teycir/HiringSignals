import {
  jobStatusSchema,
  locationModeSchema,
  roleCategorySchema,
  type LocationMode,
  type NormalizedJob,
  type RoleCategory,
} from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import { decodeJsonFromBase64Url, encodeJsonToBase64Url } from "../../../lib/text/base64url";
import type { JobDetail, JobListItem } from "./types";

export type { JobDetail, JobListItem } from "./types";

/** Raw D1 row shape (snake_case) for the `jobs` table (spec §8.2). */
export interface JobRow {
  id: string;
  source_id: string;
  company_id: string;
  external_job_id: string;
  canonical_url: string;
  title_raw: string;
  title_normalized: string;
  description_text: string | null;
  department_raw: string | null;
  employment_type: string | null;
  location_raw: string | null;
  location_mode: string;
  country_code: string | null;
  region_code: string | null;
  city: string | null;
  role_primary: string | null;
  role_tags_json: string;
  classification_confidence: number | null;
  classification_version: string | null;
  posted_at: string | null;
  source_updated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  missing_run_count: number;
  status: string;
  content_hash: string;
  /** requisitionId as parsed by the adapter (spec §7's third
   * likely-duplicate field), NULL for adapters that don't expose one
   * and for every row created before migration 0009. Not part of
   * content_hash (lib/text/content-hash.ts) -- it identifies the same
   * requisition across re-postings rather than signaling a content
   * edit, so a requisitionId change alone shouldn't trigger a
   * job_updated evidence row. */
  requisition_id: string | null;
}

/**
 * Looks up an existing job's lifecycle-relevant fields by its natural key
 * (source_id, external_job_id) -- used by the ingest consumer
 * (ROADMAP.md Milestone D) to read the prior state (status,
 * missing_run_count, first_seen_at) before upsertJob overwrites the
 * observed fields, so the lifecycle transition (Milestone B) has
 * something to transition *from*. Previously inlined as raw SQL in
 * ingest-consumer.ts; moved here so a future column rename is caught by
 * `pnpm --filter db typecheck`/test instead of silently breaking a query
 * string that lives outside packages/db.
 *
 * Also includes role_primary: the consumer's F4 content-change-as-
 * evidence path needs the job's already-classified role category to look
 * up an active signal to attach a job_updated evidence row to, without a
 * second SELECT (classification for *this* run happens later in the
 * pipeline, only for new_job/reopened_job candidates -- role_primary here
 * is whatever a *prior* run classified it as).
 */
export async function getJobByExternalId(
  client: D1Client,
  sourceId: string,
  externalJobId: string,
): Promise<Pick<
  JobRow,
  "id" | "status" | "missing_run_count" | "first_seen_at" | "role_primary"
> | null> {
  return client.first<
    Pick<JobRow, "id" | "status" | "missing_run_count" | "first_seen_at" | "role_primary">
  >(
    `SELECT id, status, missing_run_count, first_seen_at, role_primary FROM jobs WHERE source_id = ? AND external_job_id = ?`,
    [sourceId, externalJobId],
  );
}

export interface UpdateJobClassificationPatch {
  rolePrimary: string | null;
  classificationConfidence: number;
  classificationVersion: string;
}

/**
 * Writes the classifier's output (ROADMAP.md Milestone B's classifyJob())
 * onto a job row. Separate from upsertJob and applyLifecycleTransition on
 * purpose -- classification runs after both, as its own write, so this
 * repo function doesn't need to know about the classifier itself, only
 * the shape of its result. Previously inlined as raw SQL in
 * ingest-consumer.ts (same reasoning as getJobByExternalId above).
 *
 * companyId is required (debug-codebase-audit.md H1, tenant-isolation
 * defense-in-depth, same pattern as sources-repo.ts's updateSource/
 * markSourceSuccess): the row's own company_id is already in scope at
 * every real call site (processNormalizedJob's `source.company_id`), so
 * this is a defense-in-depth qualifier, not new plumbing -- a caller
 * that passes the wrong company_id for a genuine jobId now affects 0
 * rows instead of silently mutating a row belonging to a different
 * company.
 */
export async function updateJobClassification(
  client: D1Client,
  jobId: string,
  companyId: string,
  patch: UpdateJobClassificationPatch,
): Promise<void> {
  await client.run(
    `UPDATE jobs SET role_primary = ?, classification_confidence = ?, classification_version = ? WHERE id = ? AND company_id = ?`,
    [
      patch.rolePrimary,
      patch.classificationConfidence,
      patch.classificationVersion,
      jobId,
      companyId,
    ],
  );
}

/**
 * Input to upsertJob: the adapter's NormalizedJob plus the write-path
 * context (which source/company it belongs to, and the content hash
 * computed from the normalized fields per spec §5.3 "capture a
 * deterministic normalized-content hash to detect edits").
 *
 * Classification fields are intentionally absent here -- classification
 * (ROADMAP.md Milestone B) runs after upsert, as a separate write, so this
 * repo function doesn't need to know about the classifier.
 */
export interface UpsertJobInput {
  sourceId: string;
  companyId: string;
  externalJobId: string;
  canonicalUrl: string;
  title: NormalizedJob["title"];
  titleNormalized: string;
  descriptionText?: string;
  department?: string;
  employmentType?: string;
  locationRaw?: string;
  locationMode?: "remote" | "hybrid" | "onsite" | "unknown";
  countryCode?: string;
  regionCode?: string;
  city?: string;
  postedAt?: string;
  sourceUpdatedAt?: string;
  requisitionId?: string;
  contentHash: string;
  observedAt: string;
}

/** Result of upsertJob: the row's id plus whether this call changed its content_hash. */
export interface UpsertJobResult {
  id: string;
  /**
   * True when an existing row's content_hash differed from the newly
   * computed one (a real edit to title/description/department/
   * employment type/location -- see lib/text/content-hash.ts for exactly
   * which fields feed the hash). False for a brand-new job (nothing to
   * compare against) and false when an existing row's hash is unchanged.
   * Callers use this to decide whether a `job_updated` evidence row is
   * warranted (spec F4: a content change on an already-signaled role is
   * itself evidence worth surfacing, distinct from new_job/reopened_job).
   */
  contentChanged: boolean;
  /**
   * The pre-upsert row (lifecycle-relevant fields only), or `null` for a
   * brand-new job -- same shape getJobByExternalId used to return.
   * ROADMAP.md J.1 (2026-08-04): folded getJobByExternalId's separate
   * SELECT into this function's own internal existing-row lookup (same
   * WHERE, same table, same round trip) so callers that need both the
   * upsert AND the prior state (the ingest consumer's lifecycle-
   * transition input) don't pay for two SELECTs where one already
   * covers both column sets. `null` here means the same thing
   * `!existing` meant at the old getJobByExternalId call site: this
   * job_id is brand-new, so there is no "prior state" to transition
   * from.
   */
  existing: Pick<JobRow, "status" | "missing_run_count" | "first_seen_at" | "role_primary"> | null;
}

/**
 * Upserts one job keyed on the schema's own `UNIQUE(source_id,
 * external_job_id)` constraint (spec §5.3: "use a unique job key of
 * source_id + external_job_id"). On conflict, only updates fields that
 * can legitimately change between observations -- never overwrites
 * first_seen_at or id, per ROADMAP.md Milestone A.
 *
 * Does NOT touch status/missing_run_count -- those are owned exclusively
 * by applyLifecycleTransition (below), which is called by the lifecycle
 * engine (ROADMAP.md Milestone B), not from here. Keeping "upsert the
 * observed fields" and "decide/write the lifecycle state" as separate
 * writes avoids this function silently overriding a lifecycle decision
 * made by a different code path in the same request.
 *
 * Returns the row's id (existing or newly generated) so the caller can
 * pass it to insertJobObservation without a second SELECT, plus
 * contentChanged (see UpsertJobResult) so the caller can decide whether
 * to record a job_updated evidence row without a second query.
 *
 * The UPDATE branch's WHERE also qualifies on `company_id` (debug-
 * codebase-audit.md H1, same tenant-isolation defense-in-depth as
 * updateJobClassification/applyLifecycleTransition below): `existing`
 * is looked up by (source_id, external_job_id) only, so its `company_id`
 * isn't re-verified against `input.companyId` before this point --
 * qualifying the UPDATE itself is what turns a caller passing a
 * mismatched companyId (a bug elsewhere, not a normal path -- every
 * real call site derives companyId from the same source row that
 * produced sourceId) into a 0-row no-op instead of a cross-tenant write.
 */
export interface PreparedJobUpsert {
  /** Same result shape upsertJob has always returned. */
  result: UpsertJobResult;
  /** The write this upsert still needs -- not yet executed. Pass to
   * client.batch() (optionally alongside applyLifecycleTransition's
   * own prepared statement -- see buildLifecycleStatement below) or
   * run it alone via client.run(statement.sql, statement.params). */
  statement: { sql: string; params: unknown[] };
}

/**
 * Same read-then-decide logic upsertJob has always had, split so the
 * resulting write statement can be deferred and batched by the caller
 * instead of executed immediately (ROADMAP.md J.4, subrequest-limit
 * fix, 2026-08-11: processNormalizedJob's per-job upsertJob +
 * applyLifecycleTransition sequence was 2 of the 3+ D1 calls/job that
 * blew past the free-plan 1000-Cloudflare-service-subrequest ceiling
 * on large boards -- see ingest-consumer.ts's processNormalizedJob for
 * the batched call site). Does the SELECT (a real prerequisite --
 * lifecycle computation needs `existing` before the caller can even
 * build the lifecycle statement, so this part cannot itself be
 * deferred), then returns the write as data instead of running it.
 *
 * upsertJob (below) is now a thin wrapper: prepare, then run the one
 * statement immediately -- every other call site keeps working exactly
 * as before, unchanged signature and behavior.
 */
export async function prepareJobUpsert(
  client: D1Client,
  input: UpsertJobInput,
): Promise<PreparedJobUpsert> {
  // ROADMAP.md J.1 (2026-08-04): SELECT widened from `id, content_hash`
  // to also include status/missing_run_count/first_seen_at/role_primary
  // -- the exact column set the ingest consumer's now-removed separate
  // getJobByExternalId call used to fetch in its own round trip. Same
  // WHERE, same table, same row -- one SELECT now serves both purposes.
  const existing = await client.first<
    Pick<
      JobRow,
      "id" | "content_hash" | "status" | "missing_run_count" | "first_seen_at" | "role_primary"
    >
  >(
    `SELECT id, content_hash, status, missing_run_count, first_seen_at, role_primary
     FROM jobs WHERE source_id = ? AND external_job_id = ?`,
    [input.sourceId, input.externalJobId],
  );

  if (existing) {
    return {
      result: {
        id: existing.id,
        contentChanged: existing.content_hash !== input.contentHash,
        existing: {
          status: existing.status,
          missing_run_count: existing.missing_run_count,
          first_seen_at: existing.first_seen_at,
          role_primary: existing.role_primary,
        },
      },
      statement: {
        sql: `UPDATE jobs SET
         canonical_url = ?, title_raw = ?, title_normalized = ?,
         description_text = ?, department_raw = ?, employment_type = ?,
         location_raw = ?, location_mode = ?, country_code = ?,
         region_code = ?, city = ?, posted_at = ?, source_updated_at = ?,
         requisition_id = ?, last_seen_at = ?, content_hash = ?
       WHERE id = ? AND company_id = ?`,
        params: [
          input.canonicalUrl,
          input.title,
          input.titleNormalized,
          input.descriptionText ?? null,
          input.department ?? null,
          input.employmentType ?? null,
          input.locationRaw ?? null,
          input.locationMode ?? "unknown",
          input.countryCode ?? null,
          input.regionCode ?? null,
          input.city ?? null,
          input.postedAt ?? null,
          input.sourceUpdatedAt ?? null,
          input.requisitionId ?? null,
          input.observedAt,
          input.contentHash,
          existing.id,
          input.companyId,
        ],
      },
    };
  }

  const id = crypto.randomUUID();
  return {
    result: { id, contentChanged: false, existing: null },
    statement: {
      sql: `INSERT INTO jobs (
       id, source_id, company_id, external_job_id, canonical_url,
       title_raw, title_normalized, description_text, department_raw,
       employment_type, location_raw, location_mode, country_code,
       region_code, city, role_primary, role_tags_json,
       classification_confidence, classification_version, posted_at,
       source_updated_at, requisition_id, first_seen_at, last_seen_at,
       missing_run_count, status, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, ?, ?, ?, ?, 0, 'active', ?)`,
      params: [
        id,
        input.sourceId,
        input.companyId,
        input.externalJobId,
        input.canonicalUrl,
        input.title,
        input.titleNormalized,
        input.descriptionText ?? null,
        input.department ?? null,
        input.employmentType ?? null,
        input.locationRaw ?? null,
        input.locationMode ?? "unknown",
        input.countryCode ?? null,
        input.regionCode ?? null,
        input.city ?? null,
        input.postedAt ?? null,
        input.sourceUpdatedAt ?? null,
        input.requisitionId ?? null,
        input.observedAt,
        input.observedAt,
        input.contentHash,
      ],
    },
  };
}

/**
 * Thin wrapper around prepareJobUpsert (above) that runs the write
 * immediately -- unchanged signature/behavior from before the J.4
 * split, so every call site other than processNormalizedJob's batched
 * path keeps working exactly as before.
 */
export async function upsertJob(client: D1Client, input: UpsertJobInput): Promise<UpsertJobResult> {
  const prepared = await prepareJobUpsert(client, input);
  await client.run(prepared.statement.sql, prepared.statement.params);
  return prepared.result;
}

export interface InsertJobObservationInput {
  jobId: string;
  sourceRunId: string;
  observedAt: string;
  contentHash: string;
  isPresent: boolean;
}

/**
 * One row per (job, source_run) per spec §8.2's job_observations table.
 *
 * Idempotency (spec §10.3): `idx_job_observations_idempotency` (migration
 * 0004) enforces UNIQUE(job_id, source_run_id) at the schema level, so a
 * retried queue message calling this function twice for the same pair
 * throws a D1 UNIQUE constraint error on the second call instead of
 * silently inserting a duplicate row. Callers that need retry-safety
 * (the ingest-consumer, ROADMAP.md Milestone D) must catch that error and
 * treat it as "already recorded, continue" rather than a hard failure --
 * this function itself does not swallow it, same division of
 * responsibility as DuplicateSourceError in sources-repo.ts (schema
 * enforces, caller decides what the conflict means for its own flow).
 */
export async function insertJobObservation(
  client: D1Client,
  input: InsertJobObservationInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await client.run(
    `INSERT INTO job_observations (id, job_id, source_run_id, observed_at, content_hash, is_present)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.jobId,
      input.sourceRunId,
      input.observedAt,
      input.contentHash,
      input.isPresent ? 1 : 0,
    ],
  );
  return id;
}

/**
 * The complement query the lifecycle step needs (ROADMAP.md Milestone A):
 * jobs previously active/possibly_closed for this source whose
 * external_job_id is NOT in the current run's result set.
 *
 * Only considers active/possibly_closed jobs -- an already-closed job
 * that's still absent doesn't need to be re-flagged as missing (spec
 * §5.4's table has no "closed + still absent" transition; it only moves
 * on reappearance).
 *
 * 2026-08-07 bugfix (found via local end-to-end testing against
 * Stripe's real 552-job Greenhouse board): the prior implementation
 * bound one `?` placeholder per seenExternalIds entry in a single
 * `NOT IN (...)` clause -- 552 placeholders + sourceId = 553 bound
 * params for Stripe alone, which fails every time against D1/SQLite's
 * SQLITE_LIMIT_VARIABLE_NUMBER (100, per Cloudflare's documented D1
 * limits and workerd's own default) with `D1_ERROR: too many SQL
 * variables`. Only surfaced at scale -- small fixture boards with a
 * handful of jobs never approached the limit.
 *
 * Fixed by loading the candidate set (this source's own active/
 * possibly_closed jobs -- normally small relative to the full remote
 * board, since it's bounded by how many jobs this source has ever had
 * open at once, not by the board's total size) in one parameterless-list
 * round trip, then filtering out `seenExternalIds` in application code.
 * This trades "one query with N bound params" for "one query with a
 * fixed 2 params, plus an in-memory filter over a typically-small
 * candidate set" -- no chunking/batching complexity, no risk of the
 * same limit resurfacing at a larger board size, and still exactly one
 * D1 round trip.
 *
 * `seenExternalIds` empty is still a valid case (a run that returned
 * zero jobs, e.g. an empty board): every candidate row is missing by
 * definition, so the filter below simply keeps everything.
 */
export async function getJobsMissingFromRun(
  client: D1Client,
  sourceId: string,
  seenExternalIds: string[],
): Promise<JobRow[]> {
  const candidates = await client.all<JobRow>(
    `SELECT * FROM jobs WHERE source_id = ? AND status IN ('active', 'possibly_closed')`,
    [sourceId],
  );

  if (seenExternalIds.length === 0) {
    return candidates;
  }

  const seen = new Set(seenExternalIds);
  return candidates.filter((job) => !seen.has(job.external_job_id));
}

export interface DetectionLatencyStats {
  /** Median minutes between a source_run starting and the FIRST
   * job_observations row it produced for a given job (i.e. the run that
   * first discovered that job) -- p50 of spec §12's "posting live ->
   * visible to API consumers" detection-latency metric. `null` when
   * there are zero qualifying samples (e.g. a brand-new source/company
   * with no first-observation history yet). */
  p50LatencyMinutes: number | null;
  /** 95th percentile of the same distribution. */
  p95LatencyMinutes: number | null;
  /** How many (job, first-observing-run) pairs the percentiles above
   * were computed from -- callers (source-health.mjs, ROADMAP.md K.2)
   * use this to distinguish "0 samples, no data yet" from "0 samples
   * because of a bug," and to avoid presenting a p95 computed from a
   * single-digit sample as if it were statistically meaningful. */
  sampleCount: number;
}

/**
 * Detection-latency percentiles (ROADMAP.md K.2, spec §12's primary
 * optimization-target metric: "posting live -> visible to API consumers,
 * p50 <= effective per-source pollIntervalMinutes"). Needs no schema
 * change -- entirely derived from `first_seen_at` (jobs), `started_at`
 * (source_runs), scoped via `job_observations` to the specific run that
 * FIRST observed each job.
 *
 * "First observed" is identified as the job_observations row with the
 * MIN(observed_at) for that job_id, not simply "any run for this
 * source" -- a job can be observed by many runs over its lifetime
 * (spec §5.3's job_observations is one row per (job, source_run)), and
 * detection latency is specifically about the FIRST of those, matching
 * jobs.first_seen_at's own definition (see upsertJob's INSERT branch:
 * first_seen_at is set once, on creation, never touched again).
 *
 * latency_minutes = (job_observations.observed_at of that first row) -
 * (source_runs.started_at of that same run), NOT jobs.first_seen_at
 * itself minus started_at -- they're the same instant by construction
 * (upsertJob sets first_seen_at = observedAt on INSERT, and
 * insertJobObservation's observed_at is that same value passed through
 * by the ingest consumer for the run that created the job), but going
 * through job_observations/source_runs is what makes this "the run
 * that discovered it" rather than an unscoped column-to-column diff,
 * and is what makes the sourceId/companyId filters below meaningful
 * (jobs.first_seen_at alone can't be joined back to a specific run
 * without job_observations in the middle).
 *
 * Percentiles computed in SQLite via `PERCENTILE_CONT`-equivalent
 * (SQLite has no native percentile function) using a
 * ROW_NUMBER/COUNT-based nearest-rank approximation over the ordered
 * latency values -- adequate for an ops-visibility metric (spec §13.2),
 * not a statistical guarantee; a few hundred to low-thousands of
 * samples per source is the expected v1 scale, where nearest-rank and
 * true percentile-continuous rarely diverge meaningfully.
 */
export async function getDetectionLatencyStats(
  client: D1Client,
  params: { sourceId?: string; companyId?: string; since?: string },
): Promise<DetectionLatencyStats> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.sourceId) {
    where.push("j.source_id = ?");
    args.push(params.sourceId);
  }
  if (params.companyId) {
    where.push("j.company_id = ?");
    args.push(params.companyId);
  }
  if (params.since) {
    where.push("j.first_seen_at >= ?");
    args.push(params.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // CTE 1: for each job, the job_observations row with the minimum
  // observed_at -- "the first time we saw it," joined to that
  // observation's own source_run to get started_at (the run that found
  // it, not just any run for the source).
  // CTE 2: latency in minutes for each such (job, first-run) pair.
  // Final SELECT: nearest-rank p50/p95 over the ordered latency list
  // via a self-join on ROW_NUMBER, plus the sample count.
  const row = await client.first<{
    p50_latency_minutes: number | null;
    p95_latency_minutes: number | null;
    sample_count: number;
  }>(
    `WITH first_observation AS (
       SELECT jo.job_id, MIN(jo.observed_at) AS first_observed_at
       FROM job_observations jo
       GROUP BY jo.job_id
     ),
     latencies AS (
       SELECT
         (julianday(fo.first_observed_at) - julianday(sr.started_at)) * 24 * 60 AS latency_minutes,
         ROW_NUMBER() OVER (ORDER BY (julianday(fo.first_observed_at) - julianday(sr.started_at))) AS rn,
         COUNT(*) OVER () AS total
       FROM first_observation fo
       JOIN job_observations jo ON jo.job_id = fo.job_id AND jo.observed_at = fo.first_observed_at
       JOIN source_runs sr ON sr.id = jo.source_run_id
       JOIN jobs j ON j.id = fo.job_id
       ${whereClause}
     )
     SELECT
       (SELECT latency_minutes FROM latencies WHERE rn = CAST((0.50 * (total - 1)) AS INTEGER) + 1 LIMIT 1)
         AS p50_latency_minutes,
       (SELECT latency_minutes FROM latencies WHERE rn = CAST((0.95 * (total - 1)) AS INTEGER) + 1 LIMIT 1)
         AS p95_latency_minutes,
       (SELECT total FROM latencies LIMIT 1) AS sample_count`,
    args,
  );

  return {
    p50LatencyMinutes: row?.p50_latency_minutes ?? null,
    p95LatencyMinutes: row?.p95_latency_minutes ?? null,
    sampleCount: row?.sample_count ?? 0,
  };
}

export interface ApplyLifecycleTransitionPatch {
  status: "active" | "possibly_closed" | "closed";
  missingRunCount: number;
  lastSeenAt?: string;
}

/**
 * Single-purpose lifecycle write. Called by the lifecycle engine
 * (ROADMAP.md Milestone B, a pure function implementing spec §5.4's
 * table) -- never by adapters or the consumer directly. This keeps the
 * state-machine *decision* (pure, unit-testable without D1) separate
 * from the state-machine *write* (this function).
 *
 * lastSeenAt is optional: a job transitioning to possibly_closed/closed
 * because it was absent this run should NOT have last_seen_at bumped to
 * now (it wasn't seen now) -- only pass lastSeenAt when the job
 * reappeared (spec §5.4 "Job returns after closure -> mark active").
 * upsertJob already advances last_seen_at for jobs seen this run, so the
 * common "still active, still present" case doesn't need this function
 * to touch it at all.
 *
 * companyId is required (debug-codebase-audit.md H1, same tenant-
 * isolation reasoning as updateJobClassification above). Both call sites
 * (processNormalizedJob's `source.company_id`, processMissingJobs'
 * `missingJob.company_id` -- the latter using the JobRow's own column
 * rather than the source's, since it's the more precise scoping key for
 * a row already loaded from `jobs`) have it in scope.
 */
/**
 * Pure statement builder for applyLifecycleTransition's write -- no I/O,
 * just SQL + params (ROADMAP.md J.4, subrequest-limit fix, 2026-08-11).
 * Exists so processNormalizedJob can batch this statement together with
 * prepareJobUpsert's (both are same-row UPDATE/INSERT writes on `jobs`
 * with no idempotency-catch dependency between them, unlike
 * insertObservationIdempotent -- see ingest-consumer.ts's header comment
 * point 2 for why that one is never a batch candidate). Same
 * lastSeenAt-optional branching applyLifecycleTransition has always had.
 */
export function buildLifecycleStatement(
  jobId: string,
  companyId: string,
  patch: ApplyLifecycleTransitionPatch,
): { sql: string; params: unknown[] } {
  if (patch.lastSeenAt !== undefined) {
    return {
      sql: `UPDATE jobs SET status = ?, missing_run_count = ?, last_seen_at = ? WHERE id = ? AND company_id = ?`,
      params: [patch.status, patch.missingRunCount, patch.lastSeenAt, jobId, companyId],
    };
  }
  return {
    sql: `UPDATE jobs SET status = ?, missing_run_count = ? WHERE id = ? AND company_id = ?`,
    params: [patch.status, patch.missingRunCount, jobId, companyId],
  };
}

/**
 * Thin wrapper around buildLifecycleStatement (above) that runs the
 * write immediately -- unchanged signature/behavior from before the J.4
 * split. processMissingJobs (ingest-consumer.ts) keeps calling this
 * directly: it has no upsertJob write in the same iteration to batch
 * with (missing jobs are transitioned, not upserted), so there's
 * nothing to gain by using the builder there.
 */
export async function applyLifecycleTransition(
  client: D1Client,
  jobId: string,
  companyId: string,
  patch: ApplyLifecycleTransitionPatch,
): Promise<void> {
  const statement = buildLifecycleStatement(jobId, companyId, patch);
  await client.run(statement.sql, statement.params);
}

/**
 * Thrown when a `jobs` row has a value outside the domain enum for a
 * column typed as one of RoleCategory/LocationMode/JobStatus at the API
 * boundary. Same reasoning as signals-repo.ts's CorruptSignalRowError --
 * kept as a distinct exported class so a job-row problem and a
 * signal-row problem are never conflated in a caller's catch block.
 */
export class CorruptJobRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptJobRowError";
  }
}

/** Joined row shape shared by listJobsForCompany and getJobById --
 * `jobs` plus `companies` (slug/display_name) and `sources` (provider),
 * the same two joins BASE_SELECT in signals-repo.ts already makes for
 * signal rows, applied here directly to jobs instead of by way of
 * signal_evidence. */
interface JobJoinedRow extends JobRow {
  company_slug: string;
  company_display_name: string;
  source_platform: string;
}

const JOB_BASE_SELECT = `
  SELECT j.*, c.slug AS company_slug, c.display_name AS company_display_name,
         src.provider AS source_platform
  FROM jobs j
  JOIN companies c ON c.id = j.company_id
  JOIN sources src ON src.id = j.source_id
`;

/**
 * Converts one joined DB row to the API-shaped JobListItem, validating
 * the three DB-enum columns (role_primary, location_mode, status) the
 * same way signals-repo.ts's toListItem validates role_category/
 * signal_type/status -- a stale write, manual edit, or taxonomy change
 * since the row was written throws CorruptJobRowError so the caller can
 * skip-and-log rather than 500 the whole page over one bad row.
 * role_primary is nullable (a job that hasn't been classified yet, or
 * that the classifier couldn't confidently categorize) -- only validated
 * against the enum when non-null.
 */
export function toJobListItem(row: JobJoinedRow): JobListItem {
  const roleCategory =
    row.role_primary === null ? null : roleCategorySchema.safeParse(row.role_primary);
  if (roleCategory && !roleCategory.success) {
    throw new CorruptJobRowError(`Job ${row.id} has invalid role_primary="${row.role_primary}".`);
  }
  const locationMode = locationModeSchema.safeParse(row.location_mode);
  if (!locationMode.success) {
    throw new CorruptJobRowError(`Job ${row.id} has invalid location_mode="${row.location_mode}".`);
  }
  const status = jobStatusSchema.safeParse(row.status);
  if (!status.success) {
    throw new CorruptJobRowError(`Job ${row.id} has invalid status="${row.status}".`);
  }

  return {
    id: row.id,
    companyId: row.company_id,
    companySlug: row.company_slug,
    companyDisplayName: row.company_display_name,
    sourceId: row.source_id,
    sourcePlatform: row.source_platform,
    externalJobId: row.external_job_id,
    canonicalUrl: row.canonical_url,
    title: row.title_raw,
    department: row.department_raw,
    employmentType: row.employment_type,
    locationMode: locationMode.data,
    countryCode: row.country_code,
    regionCode: row.region_code,
    city: row.city,
    roleCategory: roleCategory ? roleCategory.data : null,
    classificationConfidence: row.classification_confidence,
    postedAt: row.posted_at,
    requisitionId: row.requisition_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    status: status.data,
  };
}

/** Opaque cursor for listJobsForCompany, same base64url-JSON shape as
 * signals-repo.ts's DecodedCursor -- carries the sort mode so a request
 * that changes `sort` mid-pagination is rejected instead of silently
 * paginated against the wrong ORDER BY. */
interface JobsDecodedCursor {
  sort: ListJobsForCompanyParams["sort"];
  postedAt: string | null;
  firstSeenAt: string;
  title: string;
  id: string;
}

/** Thrown when a jobs-list cursor is malformed or was issued for a
 * different `sort` than the current request -- same role
 * signals-repo.ts's InvalidCursorError plays there. */
export class InvalidJobsCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobsCursorError";
  }
}

function encodeJobsCursor(
  sort: ListJobsForCompanyParams["sort"],
  row: Pick<JobRow, "posted_at" | "first_seen_at" | "title_normalized" | "id">,
): string {
  const payload: JobsDecodedCursor = {
    sort,
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at,
    title: row.title_normalized,
    id: row.id,
  };
  return encodeJsonToBase64Url(payload);
}

function decodeJobsCursor(
  cursor: string,
  expectedSort: ListJobsForCompanyParams["sort"],
): JobsDecodedCursor {
  let decoded: JobsDecodedCursor;
  try {
    decoded = decodeJsonFromBase64Url<JobsDecodedCursor>(cursor);
  } catch {
    throw new InvalidJobsCursorError("Invalid cursor: not decodable.");
  }
  if (decoded.sort !== expectedSort) {
    throw new InvalidJobsCursorError(
      `Invalid cursor: was issued for sort=${decoded.sort}, but request has sort=${expectedSort}.`,
    );
  }
  return decoded;
}

export interface ListJobsForCompanyParams {
  companyId: string;
  roles?: RoleCategory[];
  locationMode?: LocationMode;
  status: "active" | "possibly_closed" | "closed";
  sort: "newest" | "oldest" | "title_asc";
  cursor?: string;
  limit: number;
}

export interface ListJobsForCompanyResult {
  items: JobListItem[];
  nextCursor: string | null;
}

/**
 * Raw per-job listing for one company (new: GET /api/v1/companies/:slug/jobs).
 * Reads directly from `jobs` -- no signals/signal_evidence involved --
 * so a job that never triggered a signal (below scoring threshold, or a
 * role category with no active saved filter matching it) is still
 * visible here. `sort=newest`/`oldest` order by posted_at when present,
 * falling back to first_seen_at for jobs whose adapter never supplied a
 * postedAt (COALESCE, matches the nullable postedAt field every adapter
 * doesn't populate -- see NormalizedJob's own header comment on
 * job.ts). `title_asc` is the one sort with no numeric tiebreak need
 * beyond id, since title collisions are rare and no ordering guarantee
 * beyond "roughly alphabetical, stable" is promised.
 *
 * Same fetch-one-extra-row-for-nextCursor + per-row corrupt-row-degrade
 * pattern as signals-repo.ts's listSignals, for the same reasons: one
 * bad row must not 500 the whole page, and pagination must be provably
 * stable across concurrent writes.
 */
export async function listJobsForCompany(
  client: D1Client,
  params: ListJobsForCompanyParams,
): Promise<ListJobsForCompanyResult> {
  const where: string[] = ["j.company_id = ?", "j.status = ?"];
  const args: unknown[] = [params.companyId, params.status];

  if (params.roles?.length) {
    where.push(`j.role_primary IN (${params.roles.map(() => "?").join(",")})`);
    args.push(...params.roles);
  }
  if (params.locationMode) {
    where.push("j.location_mode = ?");
    args.push(params.locationMode);
  }

  const orderBy =
    params.sort === "oldest"
      ? "COALESCE(j.posted_at, j.first_seen_at) ASC, j.id ASC"
      : params.sort === "title_asc"
        ? "j.title_normalized ASC, j.id ASC"
        : "COALESCE(j.posted_at, j.first_seen_at) DESC, j.id DESC";

  if (params.cursor) {
    const cur = decodeJobsCursor(params.cursor, params.sort);
    if (params.sort === "oldest") {
      where.push(
        "(COALESCE(j.posted_at, j.first_seen_at) > ? OR (COALESCE(j.posted_at, j.first_seen_at) = ? AND j.id > ?))",
      );
      args.push(cur.postedAt ?? cur.firstSeenAt, cur.postedAt ?? cur.firstSeenAt, cur.id);
    } else if (params.sort === "title_asc") {
      where.push("(j.title_normalized > ? OR (j.title_normalized = ? AND j.id > ?))");
      args.push(cur.title, cur.title, cur.id);
    } else {
      where.push(
        "(COALESCE(j.posted_at, j.first_seen_at) < ? OR (COALESCE(j.posted_at, j.first_seen_at) = ? AND j.id < ?))",
      );
      args.push(cur.postedAt ?? cur.firstSeenAt, cur.postedAt ?? cur.firstSeenAt, cur.id);
    }
  }

  const sql = `${JOB_BASE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`;
  const rows = await client.all<JobJoinedRow>(sql, [...args, params.limit + 1]);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  const items: JobListItem[] = [];
  let lastValid: JobJoinedRow | undefined;
  for (const row of page) {
    try {
      items.push(toJobListItem(row));
      lastValid = row;
    } catch (err) {
      if (err instanceof CorruptJobRowError) {
        console.error("corrupt_job_row_skipped", { jobId: row.id, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  return {
    items,
    nextCursor: hasMore && lastValid ? encodeJobsCursor(params.sort, lastValid) : null,
  };
}

/**
 * Single-job detail (new: GET /api/v1/jobs/:jobId) -- every column
 * JobListItem omits (description, raw location string, role tags,
 * classification version, source_updated_at, missing_run_count) plus a
 * lightweight observationCount derived from job_observations, so a
 * caller can see how many times this posting has actually been
 * confirmed present without a separate evidence lookup (signal_evidence
 * only exists for jobs that triggered a signal; job_observations exists
 * for every job, every run).
 */
export async function getJobById(client: D1Client, jobId: string): Promise<JobDetail | null> {
  const row = await client.first<JobJoinedRow>(`${JOB_BASE_SELECT} WHERE j.id = ?`, [jobId]);
  if (!row) return null;

  const observationRow = await client.first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?`,
    [jobId],
  );

  let roleTags: RoleCategory[] = [];
  try {
    const parsed = JSON.parse(row.role_tags_json);
    if (Array.isArray(parsed)) {
      roleTags = parsed.filter(
        (tag): tag is RoleCategory => roleCategorySchema.safeParse(tag).success,
      );
    }
  } catch (err) {
    console.error("corrupt_job_role_tags_json", {
      jobId: row.id,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Same per-row degrade as listJobsForCompany -- on a detail page this
  // just means "this one job has a stale enum value," not a 500.
  let listItem: JobListItem;
  try {
    listItem = toJobListItem(row);
  } catch (err) {
    if (err instanceof CorruptJobRowError) {
      console.error("corrupt_job_detail_fallback", { jobId: row.id, reason: err.message });
      // Unavoidable type holes by construction: this branch is only
      // reachable when toJobListItem rejected row.location_mode /
      // row.role_primary / row.status as outside the domain enum,
      // meaning a strict parse would have to throw here too. The
      // whole purpose of this fallback is to return SOMETHING for the
      // detail page instead of 500ing (contrast listJobsForCompany's
      // list view, which can just skip the bad row and keep the rest
      // of the page). Passing raw strings through is the stated
      // contract (see the "degrades gracefully for a corrupt status"
      // test) -- the `as JobListItem[...]` casts are what let us keep
      // that contract without a second parallel type that relaxes the
      // three enum fields to string for this one call site.
      listItem = {
        id: row.id,
        companyId: row.company_id,
        companySlug: row.company_slug,
        companyDisplayName: row.company_display_name,
        sourceId: row.source_id,
        sourcePlatform: row.source_platform,
        externalJobId: row.external_job_id,
        canonicalUrl: row.canonical_url,
        title: row.title_raw,
        department: row.department_raw,
        employmentType: row.employment_type,
        locationMode: row.location_mode as JobListItem["locationMode"],
        countryCode: row.country_code,
        regionCode: row.region_code,
        city: row.city,
        roleCategory: row.role_primary as JobListItem["roleCategory"],
        classificationConfidence: row.classification_confidence,
        postedAt: row.posted_at,
        requisitionId: row.requisition_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        status: row.status as JobListItem["status"],
      };
    } else {
      throw err;
    }
  }

  return {
    ...listItem,
    descriptionText: row.description_text,
    locationRaw: row.location_raw,
    roleTags,
    classificationVersion: row.classification_version,
    sourceUpdatedAt: row.source_updated_at,
    missingRunCount: row.missing_run_count,
    observationCount: observationRow?.count ?? 0,
  };
}
