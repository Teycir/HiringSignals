import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource, recordSourceRunStart } from "../src/sources-repo";
import {
  upsertJob,
  insertJobObservation,
  getDetectionLatencyStats,
  updateJobClassification,
  applyLifecycleTransition,
  listJobsForCompany,
  getJobById,
  toJobListItem,
  InvalidJobsCursorError,
  CorruptJobRowError,
  type JobRow,
} from "../src/jobs-repo";

/**
 * `getDetectionLatencyStats` (ROADMAP.md K.2, spec §15) test coverage.
 * Previously only manually verified twice (an isolated hand-built SQLite
 * dataset check, and a live smoke-test run of `source-health.mjs`
 * against local D1) -- this file is the first automated `packages/db`
 * test for it, closing that gap per ROADMAP.md K.2's own verify step.
 *
 * Same live-D1 conventions as the rest of this directory
 * (`@hiring-signals/test-support`'s `createLiveD1Client`, `test-jrp`
 * slug prefix, FK-safe `finally` cleanup + `afterEach` sweep).
 *
 * Seeding shape per sample: one company/source/job via the real repo
 * functions, one `source_runs` row via `recordSourceRunStart` (only
 * `started_at` matters to the query under test -- `completed_at`/
 * `status` are never read by `getDetectionLatencyStats`, so seeding
 * skips `recordSourceRunComplete` entirely to keep each sample to 3
 * live D1 calls instead of 4, same "every live wrangler call is a real,
 * ~3.7s cost" reasoning as this package's vitest.config.ts comment),
 * one `job_observations` row via `insertJobObservation` with an
 * explicit `observedAt` -- latency_minutes is exactly
 * (observedAt - source_runs.started_at) in minutes, per the function's
 * own doc comment. Multiple observations for the same job (a later
 * re-poll) are seeded in the "uses the FIRST observation, not any
 * observation" test to confirm the MIN(observed_at) grouping.
 *
 * Sample counts in the multi-sample tests are kept to 3 (not more) so
 * each test's total live-call count comfortably clears this package's
 * 90s per-test vitest timeout -- same budgeting discipline as
 * company-role-stats-repo.test.ts's heaviest test (4 seed calls, no
 * timeout override needed).
 */

const TEST_PREFIX = "test-jrp";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** All 5 statements run in one client.batch() call -- D1's real
 * atomicity primitive (see lib/d1/client.ts's batch() header comment;
 * D1 has no BEGIN/COMMIT SQL surface via the Workers binding) -- so a
 * mid-sequence process kill can't leave this company's rows
 * half-deleted (data-integrity concern, 2026-08-02). */
async function cleanupCompany(companyId: string): Promise<void> {
  await client.batch([
    {
      sql: `DELETE FROM job_observations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = ?)`,
      params: [companyId],
    },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM sources WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
}

/** Same batch() atomicity reasoning as cleanupCompany above. */
afterEach(async () => {
  await client.batch([
    {
      sql: `DELETE FROM job_observations WHERE job_id IN (
         SELECT id FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
       )`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (
         SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
       )`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    { sql: `DELETE FROM companies WHERE slug LIKE ?`, params: [`${TEST_PREFIX}-%`] },
  ]);
});

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

async function seedSource(companyId: string, companySlug: string) {
  return createSource(client, {
    companyId,
    provider: "greenhouse",
    boardToken: companySlug,
    publicUrl: `https://example.invalid/${companySlug}`,
  });
}

/** Seeds one job with one job_observations row tied to a source_run whose
 * started_at is controlled, so latency_minutes = observedAt - startedAt
 * exactly. Returns the job id for the caller's own assertions. */
async function seedJobWithObservation(params: {
  sourceId: string;
  companyId: string;
  externalJobId: string;
  startedAt: string;
  observedAt: string;
}) {
  const sourceRunId = await recordSourceRunStart(client, {
    sourceId: params.sourceId,
    startedAt: params.startedAt,
  });
  const job = await upsertJob(client, {
    sourceId: params.sourceId,
    companyId: params.companyId,
    externalJobId: params.externalJobId,
    canonicalUrl: `https://example.invalid/jobs/${params.externalJobId}`,
    title: "Security Engineer",
    titleNormalized: "security engineer",
    contentHash: `hash-${params.externalJobId}`,
    observedAt: params.observedAt,
  });
  await insertJobObservation(client, {
    jobId: job.id,
    sourceRunId,
    observedAt: params.observedAt,
    contentHash: `hash-${params.externalJobId}`,
    isPresent: true,
  });
  return { job, sourceRunId };
}

describe("getDetectionLatencyStats", () => {
  it("returns null p50/p95 and sampleCount 0 when no qualifying observations exist", async () => {
    const company = await seedCompany("empty", "Detection Latency Empty Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const stats = await getDetectionLatencyStats(client, { sourceId: source.id });
      expect(stats.p50LatencyMinutes).toBeNull();
      expect(stats.p95LatencyMinutes).toBeNull();
      expect(stats.sampleCount).toBe(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("computes latency_minutes as observed_at minus the source_run's started_at for a single sample", async () => {
    const company = await seedCompany("single", "Detection Latency Single Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await seedJobWithObservation({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-1",
        startedAt: "2026-07-30T06:00:00.000Z",
        observedAt: "2026-07-30T06:10:00.000Z",
      });

      const stats = await getDetectionLatencyStats(client, { sourceId: source.id });
      expect(stats.sampleCount).toBe(1);
      expect(stats.p50LatencyMinutes).toBeCloseTo(10, 5);
      expect(stats.p95LatencyMinutes).toBeCloseTo(10, 5);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("computes p50/p95 across multiple samples for one source, scoped by sourceId", async () => {
    const company = await seedCompany("multi", "Detection Latency Multi Co");
    try {
      const source = await seedSource(company.id, company.slug);
      // Latencies: 5, 15, 100 minutes -- nearest-rank over 3 sorted
      // samples (indices 0..2) puts p50 at index floor(0.50*2)=1 -> 15,
      // p95 at index floor(0.95*2)=1 -> 15 too (matches the function's
      // own CAST(0.50*(total-1)) / CAST(0.95*(total-1)) nearest-rank
      // math -- with only 3 samples p50 and p95 legitimately land on
      // the same rank; this still exercises the percentile SQL path
      // distinctly from the single-sample test above, just not a
      // p50 != p95 case, which needs more samples than 3 comfortably
      // buys within this package's 90s per-test timeout).
      const latenciesMinutes = [5, 15, 100];
      for (const [i, minutes] of latenciesMinutes.entries()) {
        await seedJobWithObservation({
          sourceId: source.id,
          companyId: company.id,
          externalJobId: `job-multi-${i}`,
          startedAt: "2026-07-30T06:00:00.000Z",
          observedAt: new Date(Date.parse("2026-07-30T06:00:00.000Z") + minutes * 60 * 1000).toISOString(),
        });
      }

      const stats = await getDetectionLatencyStats(client, { sourceId: source.id });
      expect(stats.sampleCount).toBe(3);
      expect(stats.p50LatencyMinutes).toBeCloseTo(15, 5);
      expect(stats.p95LatencyMinutes).toBeCloseTo(15, 5);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("uses the FIRST observation for a job, not a later re-poll observation", async () => {
    const company = await seedCompany("first-obs", "Detection Latency First Obs Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const { job, sourceRunId: firstRunId } = await seedJobWithObservation({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-reobserved",
        startedAt: "2026-07-30T06:00:00.000Z",
        observedAt: "2026-07-30T06:05:00.000Z",
      });

      // A later run re-observes the same job (still present at next poll).
      const laterRunId = await recordSourceRunStart(client, {
        sourceId: source.id,
        startedAt: "2026-07-30T12:00:00.000Z",
      });
      await insertJobObservation(client, {
        jobId: job.id,
        sourceRunId: laterRunId,
        observedAt: "2026-07-30T12:00:30.000Z",
        contentHash: "hash-job-reobserved",
        isPresent: true,
      });

      const stats = await getDetectionLatencyStats(client, { sourceId: source.id });
      expect(stats.sampleCount).toBe(1);
      // Must reflect the FIRST run's 5-minute latency, not the later
      // run's much larger gap from its own started_at.
      expect(stats.p50LatencyMinutes).toBeCloseTo(5, 5);
      expect(firstRunId).not.toBe(laterRunId);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("filters by companyId, excluding another company's samples", async () => {
    const companyA = await seedCompany("scope-a", "Detection Latency Scope A Co");
    const companyB = await seedCompany("scope-b", "Detection Latency Scope B Co");
    try {
      const sourceA = await seedSource(companyA.id, companyA.slug);
      const sourceB = await seedSource(companyB.id, companyB.slug);
      await seedJobWithObservation({
        sourceId: sourceA.id,
        companyId: companyA.id,
        externalJobId: "job-a",
        startedAt: "2026-07-30T06:00:00.000Z",
        observedAt: "2026-07-30T06:07:00.000Z",
      });
      await seedJobWithObservation({
        sourceId: sourceB.id,
        companyId: companyB.id,
        externalJobId: "job-b",
        startedAt: "2026-07-30T06:00:00.000Z",
        observedAt: "2026-07-30T06:59:00.000Z",
      });

      const statsA = await getDetectionLatencyStats(client, { companyId: companyA.id });
      expect(statsA.sampleCount).toBe(1);
      expect(statsA.p50LatencyMinutes).toBeCloseTo(7, 5);
    } finally {
      await cleanupCompany(companyA.id);
      await cleanupCompany(companyB.id);
    }
  });

  it("filters by since, excluding jobs first seen before the cutoff", async () => {
    const company = await seedCompany("since", "Detection Latency Since Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await seedJobWithObservation({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-old",
        startedAt: "2020-01-01T06:00:00.000Z",
        observedAt: "2020-01-01T06:03:00.000Z",
      });
      await seedJobWithObservation({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-recent",
        startedAt: "2026-07-30T06:00:00.000Z",
        observedAt: "2026-07-30T06:12:00.000Z",
      });

      const stats = await getDetectionLatencyStats(client, {
        sourceId: source.id,
        since: "2026-01-01T00:00:00.000Z",
      });
      expect(stats.sampleCount).toBe(1);
      expect(stats.p50LatencyMinutes).toBeCloseTo(12, 5);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

/**
 * H1 tenant-isolation coverage (debug-codebase-audit.md) for the three
 * jobs-repo.ts functions patched with a companyId qualifier:
 * updateJobClassification, upsertJob (UPDATE branch), and
 * applyLifecycleTransition. Each gets a happy-path test plus a
 * wrong-companyId test asserting 0 rows affected / no data change, per
 * the audit doc's own verification instruction.
 */
describe("updateJobClassification", () => {
  async function seedJob(companyId: string, sourceId: string, externalJobId: string) {
    const now = new Date().toISOString();
    return upsertJob(client, {
      sourceId,
      companyId,
      externalJobId,
      canonicalUrl: `https://example.invalid/jobs/${externalJobId}`,
      title: "Security Engineer",
      titleNormalized: "security engineer",
      contentHash: `hash-${externalJobId}`,
      observedAt: now,
    });
  }

  it("updates role_primary/classification_confidence/classification_version", async () => {
    const company = await seedCompany("ujc-basic", "Update Classification Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJob(company.id, source.id, "job-1");

      await updateJobClassification(client, job.id, company.id, {
        rolePrimary: "cybersecurity",
        classificationConfidence: 0.9,
        classificationVersion: "v2",
      });

      const persisted = await client.first<{
        role_primary: string | null;
        classification_confidence: number | null;
        classification_version: string | null;
      }>(
        `SELECT role_primary, classification_confidence, classification_version FROM jobs WHERE id = ?`,
        [job.id],
      );
      expect(persisted?.role_primary).toBe("cybersecurity");
      expect(persisted?.classification_confidence).toBeCloseTo(0.9, 5);
      expect(persisted?.classification_version).toBe("v2");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not update a job when passed a mismatched company_id", async () => {
    const company = await seedCompany("ujc-tenant", "Update Classification Tenant Co");
    const otherCompany = await seedCompany("ujc-tenant-other", "Update Classification Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJob(company.id, source.id, "job-1");

      await updateJobClassification(client, job.id, otherCompany.id, {
        rolePrimary: "cybersecurity",
        classificationConfidence: 0.9,
        classificationVersion: "v2",
      });

      const persisted = await client.first<{ role_primary: string | null }>(
        `SELECT role_primary FROM jobs WHERE id = ?`,
        [job.id],
      );
      // Unchanged -- the wrong companyId meant 0 rows matched.
      expect(persisted?.role_primary).toBeNull();
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

describe("upsertJob H1 tenant isolation (UPDATE branch)", () => {
  it("H1: a second upsertJob call with a mismatched company_id does not update the existing row", async () => {
    const company = await seedCompany("uj-tenant", "Upsert Job Tenant Co");
    const otherCompany = await seedCompany("uj-tenant-other", "Upsert Job Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date().toISOString();
      const first = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-1",
        canonicalUrl: `https://example.invalid/jobs/job-1`,
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-v1",
        observedAt: now,
      });
      expect(first.contentChanged).toBe(false);

      // Same (sourceId, externalJobId) natural key finds the existing
      // row, but a mismatched companyId is passed -- the UPDATE branch's
      // WHERE id = ? AND company_id = ? must match 0 rows.
      const later = new Date(Date.now() + 60_000).toISOString();
      await upsertJob(client, {
        sourceId: source.id,
        companyId: otherCompany.id,
        externalJobId: "job-1",
        canonicalUrl: `https://example.invalid/jobs/job-1`,
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-v2",
        observedAt: later,
      });

      const persisted = await client.first<{ content_hash: string; company_id: string }>(
        `SELECT content_hash, company_id FROM jobs WHERE id = ?`,
        [first.id],
      );
      // Unchanged -- still the original hash and original company_id.
      expect(persisted?.content_hash).toBe("hash-v1");
      expect(persisted?.company_id).toBe(company.id);
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

/**
 * requisitionId persistence (ROADMAP.md G.3 gap, migration 0009): spec
 * §7's third likely-duplicate field was parsed into NormalizedJob by
 * 3 of 8 adapters but never reached the jobs table -- upsertJob's INSERT
 * had no column for it and its UPDATE never touched it. Covers the
 * INSERT branch (new job carries a requisitionId), the UPDATE branch
 * (a later observation for the same job updates it), and the
 * omitted-field case (adapters that never set requisitionId persist
 * NULL, not a fabricated empty string).
 */
describe("upsertJob requisitionId persistence", () => {
  it("persists requisitionId on INSERT and an updated value on a later UPDATE", async () => {
    const company = await seedCompany("uj-reqid", "Upsert Job Requisition Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date().toISOString();
      const created = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-reqid-1",
        canonicalUrl: `https://example.invalid/jobs/job-reqid-1`,
        title: "Backend Engineer",
        titleNormalized: "backend engineer",
        requisitionId: "REQ-100",
        contentHash: "hash-v1",
        observedAt: now,
      });

      const afterInsert = await client.first<{ requisition_id: string | null }>(
        `SELECT requisition_id FROM jobs WHERE id = ?`,
        [created.id],
      );
      expect(afterInsert?.requisition_id).toBe("REQ-100");

      const later = new Date(Date.now() + 60_000).toISOString();
      await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-reqid-1",
        canonicalUrl: `https://example.invalid/jobs/job-reqid-1`,
        title: "Backend Engineer",
        titleNormalized: "backend engineer",
        requisitionId: "REQ-200",
        contentHash: "hash-v2",
        observedAt: later,
      });

      const afterUpdate = await client.first<{ requisition_id: string | null }>(
        `SELECT requisition_id FROM jobs WHERE id = ?`,
        [created.id],
      );
      expect(afterUpdate?.requisition_id).toBe("REQ-200");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("persists NULL when the adapter never sets requisitionId", async () => {
    const company = await seedCompany("uj-reqid-null", "Upsert Job No Requisition Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date().toISOString();
      const created = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-reqid-2",
        canonicalUrl: `https://example.invalid/jobs/job-reqid-2`,
        title: "SRE",
        titleNormalized: "sre",
        contentHash: "hash-v1",
        observedAt: now,
      });

      const row = await client.first<{ requisition_id: string | null }>(
        `SELECT requisition_id FROM jobs WHERE id = ?`,
        [created.id],
      );
      expect(row?.requisition_id).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("applyLifecycleTransition", () => {
  async function seedJob(companyId: string, sourceId: string, externalJobId: string) {
    const now = new Date().toISOString();
    return upsertJob(client, {
      sourceId,
      companyId,
      externalJobId,
      canonicalUrl: `https://example.invalid/jobs/${externalJobId}`,
      title: "Security Engineer",
      titleNormalized: "security engineer",
      contentHash: `hash-${externalJobId}`,
      observedAt: now,
    });
  }

  it("updates status and missing_run_count, and last_seen_at when provided", async () => {
    const company = await seedCompany("alt-basic", "Lifecycle Transition Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJob(company.id, source.id, "job-1");
      const lastSeenAt = "2026-08-01T00:00:00.000Z";

      await applyLifecycleTransition(client, job.id, company.id, {
        status: "possibly_closed",
        missingRunCount: 1,
        lastSeenAt,
      });

      const persisted = await client.first<{
        status: string;
        missing_run_count: number;
        last_seen_at: string;
      }>(`SELECT status, missing_run_count, last_seen_at FROM jobs WHERE id = ?`, [job.id]);
      expect(persisted?.status).toBe("possibly_closed");
      expect(persisted?.missing_run_count).toBe(1);
      expect(persisted?.last_seen_at).toBe(lastSeenAt);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("leaves last_seen_at untouched when lastSeenAt is omitted", async () => {
    const company = await seedCompany("alt-no-last-seen", "Lifecycle No Last Seen Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJob(company.id, source.id, "job-1");
      const before = await client.first<{ last_seen_at: string }>(
        `SELECT last_seen_at FROM jobs WHERE id = ?`,
        [job.id],
      );

      await applyLifecycleTransition(client, job.id, company.id, {
        status: "possibly_closed",
        missingRunCount: 1,
      });

      const after = await client.first<{ status: string; last_seen_at: string }>(
        `SELECT status, last_seen_at FROM jobs WHERE id = ?`,
        [job.id],
      );
      expect(after?.status).toBe("possibly_closed");
      expect(after?.last_seen_at).toBe(before?.last_seen_at);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not transition a job when passed a mismatched company_id", async () => {
    const company = await seedCompany("alt-tenant", "Lifecycle Tenant Co");
    const otherCompany = await seedCompany("alt-tenant-other", "Lifecycle Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJob(company.id, source.id, "job-1");

      await applyLifecycleTransition(client, job.id, otherCompany.id, {
        status: "closed",
        missingRunCount: 5,
      });

      const persisted = await client.first<{ status: string; missing_run_count: number }>(
        `SELECT status, missing_run_count FROM jobs WHERE id = ?`,
        [job.id],
      );
      // Unchanged -- wrong companyId matched 0 rows.
      expect(persisted?.status).toBe("active");
      expect(persisted?.missing_run_count).toBe(0);
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

/**
 * `listJobsForCompany`/`getJobById`/`toJobListItem` (new: GET
 * /api/v1/companies/:slug/jobs, GET /api/v1/jobs/:jobId -- the raw
 * per-job read surface signals never exposed, see jobs-repo.ts's own
 * header comments on JOB_BASE_SELECT/toJobListItem for the full
 * rationale). Mirrors signals-repo.test.ts's listSignals/getSignalDetail/
 * toListItem coverage shape: seeded via the real createCompany/
 * createSource/upsertJob write path, cursor/sort/filter behavior
 * asserted against the real live D1 return value, and one corrupt-row
 * test that bypasses upsertJob's typed input on purpose (a raw
 * client.run UPDATE) since the corruption itself -- an enum column
 * holding a value outside the domain schema -- is not producible via
 * the typed write path.
 */
async function seedJobRow(params: {
  sourceId: string;
  companyId: string;
  externalJobId: string;
  title?: string;
  postedAt?: string;
  observedAt?: string;
  locationMode?: "remote" | "hybrid" | "onsite" | "unknown";
  rolePrimary?: string;
}) {
  const observedAt = params.observedAt ?? new Date().toISOString();
  const job = await upsertJob(client, {
    sourceId: params.sourceId,
    companyId: params.companyId,
    externalJobId: params.externalJobId,
    canonicalUrl: `https://example.invalid/jobs/${params.externalJobId}`,
    title: params.title ?? "Security Engineer",
    titleNormalized: (params.title ?? "Security Engineer").toLowerCase(),
    contentHash: `hash-${params.externalJobId}`,
    observedAt,
    postedAt: params.postedAt,
    locationMode: params.locationMode,
  });
  if (params.rolePrimary) {
    await updateJobClassification(client, job.id, params.companyId, {
      rolePrimary: params.rolePrimary,
      classificationConfidence: 0.9,
      classificationVersion: "v1",
    });
  }
  return job;
}

describe("listJobsForCompany", () => {
  it("returns an active job for the company matching default filters (status=active)", async () => {
    const company = await seedCompany("ljfc-default", "List Jobs Default Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-1" });
      const result = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toContain(job.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("filters by status, excluding jobs in a different lifecycle state", async () => {
    const company = await seedCompany("ljfc-status", "List Jobs Status Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const activeJob = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-active" });
      const closedJob = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-closed" });
      await applyLifecycleTransition(client, closedJob.id, company.id, {
        status: "closed",
        missingRunCount: 3,
      });

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toContain(activeJob.id);
      expect(result.items.map((i) => i.id)).not.toContain(closedJob.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("filters by roles, matching role_primary set via updateJobClassification", async () => {
    const company = await seedCompany("ljfc-roles", "List Jobs Roles Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const secJob = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-sec",
        rolePrimary: "cybersecurity",
      });
      const swJob = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-sw",
        rolePrimary: "software_engineering",
      });

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        roles: ["cybersecurity"],
        status: "active",
        sort: "newest",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toContain(secJob.id);
      expect(result.items.map((i) => i.id)).not.toContain(swJob.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("filters by locationMode", async () => {
    const company = await seedCompany("ljfc-loc", "List Jobs Location Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const remoteJob = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-remote",
        locationMode: "remote",
      });
      const onsiteJob = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-onsite",
        locationMode: "onsite",
      });

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        locationMode: "remote",
        status: "active",
        sort: "newest",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toContain(remoteJob.id);
      expect(result.items.map((i) => i.id)).not.toContain(onsiteJob.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by posted_at DESC for sort=newest, falling back to first_seen_at when postedAt is absent", async () => {
    const company = await seedCompany("ljfc-newest", "List Jobs Newest Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const older = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-older",
        postedAt: "2026-07-01T00:00:00.000Z",
      });
      const newer = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-newer",
        postedAt: "2026-07-20T00:00:00.000Z",
      });

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 50,
      });
      const ids = result.items.map((i) => i.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by title_normalized ASC for sort=title_asc", async () => {
    const company = await seedCompany("ljfc-title", "List Jobs Title Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const zebra = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-zebra",
        title: "Zebra Engineer",
      });
      const alpha = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-alpha",
        title: "Alpha Engineer",
      });

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "title_asc",
        limit: 50,
      });
      const ids = result.items.map((i) => i.id);
      expect(ids.indexOf(alpha.id)).toBeLessThan(ids.indexOf(zebra.id));
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("sets nextCursor and trims to `limit` when limit+1 rows come back, and the cursor pages to the remainder", async () => {
    const company = await seedCompany("ljfc-cursor", "List Jobs Cursor Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const first = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-a",
        postedAt: "2026-07-20T00:00:00.000Z",
      });
      const second = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-b",
        postedAt: "2026-07-10T00:00:00.000Z",
      });

      const page1 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 1,
      });
      expect(page1.items).toHaveLength(1);
      expect(page1.items[0]?.id).toBe(first.id);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 1,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).toBe(second.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("pages cursor for sort=oldest (opposite inequality direction, same cursor encode/decode)", async () => {
    const company = await seedCompany("ljfc-cursor-oldest", "List Jobs Cursor Oldest Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const older = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-old",
        postedAt: "2026-07-10T00:00:00.000Z",
      });
      const newer = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-new",
        postedAt: "2026-07-20T00:00:00.000Z",
      });

      const page1 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "oldest",
        limit: 1,
      });
      expect(page1.items).toHaveLength(1);
      expect(page1.items[0]?.id).toBe(older.id);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "oldest",
        limit: 1,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).toBe(newer.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("pages cursor for sort=title_asc (cursor stores title_normalized, not title_raw, to match the ORDER BY key)", async () => {
    const company = await seedCompany("ljfc-cursor-title", "List Jobs Cursor Title Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const alpha = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-z",
        title: "Alpha Senior Engineer",
      });
      const beta = await seedJobRow({
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-a",
        title: "Zebra Engineer",
      });

      const page1 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "title_asc",
        limit: 1,
      });
      expect(page1.items).toHaveLength(1);
      expect(page1.items[0]?.id).toBe(alpha.id);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "title_asc",
        limit: 1,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).toBe(beta.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("throws InvalidJobsCursorError when a cursor's embedded sort mode doesn't match the request", async () => {
    const cursorForOldest = Buffer.from(
      JSON.stringify({
        sort: "oldest",
        postedAt: "2026-07-01T00:00:00.000Z",
        firstSeenAt: "2026-07-01T00:00:00.000Z",
        title: "alpha engineer",
        id: "job-1",
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(
      listJobsForCompany(client, {
        companyId: "00000000-0000-0000-0000-000000000000",
        status: "active",
        sort: "newest",
        cursor: cursorForOldest,
        limit: 50,
      }),
    ).rejects.toThrow(InvalidJobsCursorError);
  });

  it("skips a row with a corrupt location_mode instead of throwing for the whole page", async () => {
    const company = await seedCompany("ljfc-corrupt", "List Jobs Corrupt Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const goodJob = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-good" });
      const badJob = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-bad" });
      // Bypasses upsertJob's typed locationMode param on purpose -- this
      // row's whole reason for existing is being outside the valid enum,
      // which the real write path can't produce. Only badJob is
      // touched -- goodJob must stay valid so it has something to
      // assert stayed present in the result.
      await client.run(`UPDATE jobs SET location_mode = 'not_a_real_mode' WHERE id = ?`, [badJob.id]);

      const result = await listJobsForCompany(client, {
        companyId: company.id,
        status: "active",
        sort: "newest",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toContain(goodJob.id);
      expect(result.items.map((i) => i.id)).not.toContain(badJob.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("getJobById", () => {
  it("returns null for an unknown job id", async () => {
    const result = await getJobById(client, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("returns full detail including descriptionText/locationRaw/observationCount", async () => {
    const company = await seedCompany("gjbi-detail", "Get Job Detail Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date().toISOString();
      const job = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-detail-1",
        canonicalUrl: "https://example.invalid/jobs/job-detail-1",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        descriptionText: "Full job description text.",
        locationRaw: "Remote (US)",
        contentHash: "hash-detail-1",
        observedAt: now,
      });
      const sourceRunId = await recordSourceRunStart(client, { sourceId: source.id, startedAt: now });
      await insertJobObservation(client, {
        jobId: job.id,
        sourceRunId,
        observedAt: now,
        contentHash: "hash-detail-1",
        isPresent: true,
      });

      const detail = await getJobById(client, job.id);
      expect(detail).not.toBeNull();
      expect(detail!.descriptionText).toBe("Full job description text.");
      expect(detail!.locationRaw).toBe("Remote (US)");
      expect(detail!.observationCount).toBe(1);
      expect(detail!.companyId).toBe(company.id);
      expect(detail!.sourceId).toBe(source.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns observationCount 0 when the job has never been through insertJobObservation", async () => {
    const company = await seedCompany("gjbi-no-obs", "Get Job No Observation Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-no-obs" });
      const detail = await getJobById(client, job.id);
      expect(detail).not.toBeNull();
      expect(detail!.observationCount).toBe(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("degrades gracefully (does not throw) for a job with a corrupt status, still returning a JobDetail", async () => {
    const company = await seedCompany("gjbi-corrupt", "Get Job Corrupt Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const job = await seedJobRow({ sourceId: source.id, companyId: company.id, externalJobId: "job-corrupt" });
      // Bypasses upsertJob's typed status on purpose -- status is never
      // settable via UpsertJobInput itself (only applyLifecycleTransition
      // writes it, and only to valid enum values), so this raw UPDATE is
      // the only way to produce a row outside the domain enum.
      await client.run(`UPDATE jobs SET status = 'not_a_real_status' WHERE id = ?`, [job.id]);

      const detail = await getJobById(client, job.id);
      expect(detail).not.toBeNull();
      // Per getJobById's own fallback branch: the raw string passes
      // through uncoerced rather than the call throwing CorruptJobRowError.
      expect(detail!.status).toBe("not_a_real_status");
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("toJobListItem", () => {
  function makeRow(overrides: Partial<JobRow & { company_slug: string; company_display_name: string; source_platform: string }> = {}) {
    return {
      id: "job-1",
      source_id: "src-1",
      company_id: "c1",
      company_slug: "acme",
      company_display_name: "Acme Corp",
      source_platform: "greenhouse",
      external_job_id: "ext-1",
      canonical_url: "https://example.invalid/jobs/ext-1",
      title_raw: "Security Engineer",
      title_normalized: "security engineer",
      description_text: null,
      department_raw: null,
      employment_type: null,
      location_raw: null,
      location_mode: "unknown",
      country_code: null,
      region_code: null,
      city: null,
      role_primary: null,
      role_tags_json: "[]",
      classification_confidence: null,
      classification_version: null,
      posted_at: null,
      source_updated_at: null,
      first_seen_at: "2026-07-01T00:00:00.000Z",
      last_seen_at: "2026-07-02T00:00:00.000Z",
      missing_run_count: 0,
      status: "active",
      content_hash: "hash-1",
      requisition_id: null,
      ...overrides,
    };
  }

  it("maps a valid joined row to a JobListItem with camelCase fields", () => {
    const item = toJobListItem(makeRow());
    expect(item).toEqual({
      id: "job-1",
      companyId: "c1",
      companySlug: "acme",
      companyDisplayName: "Acme Corp",
      sourceId: "src-1",
      sourcePlatform: "greenhouse",
      externalJobId: "ext-1",
      canonicalUrl: "https://example.invalid/jobs/ext-1",
      title: "Security Engineer",
      department: null,
      employmentType: null,
      locationMode: "unknown",
      countryCode: null,
      regionCode: null,
      city: null,
      roleCategory: null,
      classificationConfidence: null,
      postedAt: null,
      requisitionId: null,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-02T00:00:00.000Z",
      status: "active",
    });
  });

  it("throws CorruptJobRowError for an invalid location_mode", () => {
    expect(() => toJobListItem(makeRow({ location_mode: "not_a_real_mode" }))).toThrow(CorruptJobRowError);
  });

  it("throws CorruptJobRowError for an invalid status", () => {
    expect(() => toJobListItem(makeRow({ status: "not_a_real_status" }))).toThrow(CorruptJobRowError);
  });

  it("throws CorruptJobRowError for an invalid role_primary when non-null", () => {
    expect(() => toJobListItem(makeRow({ role_primary: "not_a_real_role" }))).toThrow(CorruptJobRowError);
  });

  it("does not throw when role_primary is null (unclassified job)", () => {
    expect(() => toJobListItem(makeRow({ role_primary: null }))).not.toThrow();
  });
});
