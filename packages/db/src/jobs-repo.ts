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
 */
export async function getJobByExternalId(
  client: D1Client,
  sourceId: string,
  externalJobId: string,
): Promise<Pick<JobRow, "id" | "status" | "missing_run_count" | "first_seen_at"> | null> {
  return client.first<Pick<JobRow, "id" | "status" | "missing_run_count" | "first_seen_at">>(
    `SELECT id, status, missing_run_count, first_seen_at FROM jobs WHERE source_id = ? AND external_job_id = ?`,
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
 */
export async function updateJobClassification(
  client: D1Client,
  jobId: string,
  patch: UpdateJobClassificationPatch,
): Promise<void> {
  await client.run(
    `UPDATE jobs SET role_primary = ?, classification_confidence = ?, classification_version = ? WHERE id = ?`,
    [patch.rolePrimary, patch.classificationConfidence, patch.classificationVersion, jobId],
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
 * pass it to insertJobObservation without a second SELECT.
 */
export async function upsertJob(client: D1Client, input: UpsertJobInput): Promise<string> {
  const existing = await client.first<Pick<JobRow, "id">>(
    `SELECT id FROM jobs WHERE source_id = ? AND external_job_id = ?`,
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
       WHERE id = ?`,
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
      ],
    );
    return existing.id;
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
  return id;
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
 * Idempotency (spec §13.3): `idx_job_observations_idempotency` (migration
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
    [id, input.jobId, input.sourceRunId, input.observedAt, input.contentHash, input.isPresent ? 1 : 0],
  );
  return id;
}

/**
 * The complement query the lifecycle step needs (ROADMAP.md Milestone A):
 * jobs previously active/possibly_closed for this source whose
 * external_job_id is NOT in the current run's result set. Computed in
 * one round trip via NOT IN rather than diffing two full-table loads in
 * application code.
 *
 * Only considers active/possibly_closed jobs -- an already-closed job
 * that's still absent doesn't need to be re-flagged as missing (spec
 * §5.4's table has no "closed + still absent" transition; it only moves
 * on reappearance).
 *
 * `seenExternalIds` empty is a valid case (a run that returned zero jobs,
 * e.g. an empty board) -- guarded explicitly since SQL's `NOT IN ()` with
 * an empty list is invalid syntax in some dialects and unreliable in
 * others; when the list is empty, every previously active/possibly_closed
 * job for this source is missing by definition, so skip the NOT IN clause
 * entirely rather than trying to parameterize an empty list.
 */
export async function getJobsMissingFromRun(
  client: D1Client,
  sourceId: string,
  seenExternalIds: string[],
): Promise<JobRow[]> {
  if (seenExternalIds.length === 0) {
    return client.all<JobRow>(
      `SELECT * FROM jobs WHERE source_id = ? AND status IN ('active', 'possibly_closed')`,
      [sourceId],
    );
  }

  const placeholders = seenExternalIds.map(() => "?").join(",");
  return client.all<JobRow>(
    `SELECT * FROM jobs
     WHERE source_id = ? AND status IN ('active', 'possibly_closed')
       AND external_job_id NOT IN (${placeholders})`,
    [sourceId, ...seenExternalIds],
  );
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
 */
export async function applyLifecycleTransition(
  client: D1Client,
  jobId: string,
  patch: ApplyLifecycleTransitionPatch,
): Promise<void> {
  if (patch.lastSeenAt !== undefined) {
    await client.run(
      `UPDATE jobs SET status = ?, missing_run_count = ?, last_seen_at = ? WHERE id = ?`,
      [patch.status, patch.missingRunCount, patch.lastSeenAt, jobId],
    );
  } else {
    await client.run(`UPDATE jobs SET status = ?, missing_run_count = ? WHERE id = ?`, [
      patch.status,
      patch.missingRunCount,
      jobId,
    ]);
  }
}
