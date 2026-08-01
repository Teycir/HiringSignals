import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource, recordSourceRunStart } from "../src/sources-repo";
import { upsertJob, insertJobObservation, getDetectionLatencyStats } from "../src/jobs-repo";

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
