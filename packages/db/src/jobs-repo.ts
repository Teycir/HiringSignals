import type { NormalizedJob } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";

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
export async function upsertJob(client: D1Client, input: UpsertJobInput): Promise<UpsertJobResult> {
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
    await client.run(
      `UPDATE jobs SET
         canonical_url = ?, title_raw = ?, title_normalized = ?,
         description_text = ?, department_raw = ?, employment_type = ?,
         location_raw = ?, location_mode = ?, country_code = ?,
         region_code = ?, city = ?, posted_at = ?, source_updated_at = ?,
         last_seen_at = ?, content_hash = ?
       WHERE id = ? AND company_id = ?`,
      [
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
        input.observedAt,
        input.contentHash,
        existing.id,
        input.companyId,
      ],
    );
    return {
      id: existing.id,
      contentChanged: existing.content_hash !== input.contentHash,
      existing: {
        status: existing.status,
        missing_run_count: existing.missing_run_count,
        first_seen_at: existing.first_seen_at,
        role_primary: existing.role_primary,
      },
    };
  }

  const id = crypto.randomUUID();
  await client.run(
    `INSERT INTO jobs (
       id, source_id, company_id, external_job_id, canonical_url,
       title_raw, title_normalized, description_text, department_raw,
       employment_type, location_raw, location_mode, country_code,
       region_code, city, role_primary, role_tags_json,
       classification_confidence, classification_version, posted_at,
       source_updated_at, first_seen_at, last_seen_at, missing_run_count,
       status, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, ?, ?, ?, 0, 'active', ?)`,
    [
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
      input.observedAt,
      input.observedAt,
      input.contentHash,
    ],
  );
  return { id, contentChanged: false, existing: null };
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
   * visible in dashboard" detection-latency metric. `null` when there
   * are zero qualifying samples (e.g. a brand-new source/company with
   * no first-observation history yet). */
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
 * optimization-target metric: "posting live -> visible in dashboard,
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
export async function applyLifecycleTransition(
  client: D1Client,
  jobId: string,
  companyId: string,
  patch: ApplyLifecycleTransitionPatch,
): Promise<void> {
  if (patch.lastSeenAt !== undefined) {
    await client.run(
      `UPDATE jobs SET status = ?, missing_run_count = ?, last_seen_at = ? WHERE id = ? AND company_id = ?`,
      [patch.status, patch.missingRunCount, patch.lastSeenAt, jobId, companyId],
    );
  } else {
    await client.run(
      `UPDATE jobs SET status = ?, missing_run_count = ? WHERE id = ? AND company_id = ?`,
      [patch.status, patch.missingRunCount, jobId, companyId],
    );
  }
}
