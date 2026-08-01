import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource } from "../src/sources-repo";
import { upsertJob } from "../src/jobs-repo";
import { getCompanyRoleActivityStats } from "../src/company-role-stats-repo";

/**
 * Migrated off the retired in-memory-fake `D1Client` (AGENTS.md's "zero
 * mocks, zero fakes" policy, superseded 2026-07-30; ROADMAP.md Milestone
 * J) onto the real, live, shared `hiring-signals` D1 database via
 * `@hiring-signals/test-support`'s `createLiveD1Client`. Every test below
 * seeds real rows through the real repo functions (`createCompany`,
 * `createSource`, `upsertJob`) -- never raw hand-built INSERTs for the
 * data under test -- then calls `getCompanyRoleActivityStats` for real
 * and asserts on its real return value, per ROADMAP.md's Milestone J
 * inventory note that this file's prior fake-seeded-`first()`-result
 * tests were "mostly behavioral already" and the strictly better version
 * seeds real `jobs` rows spanning the actual date windows rather than
 * one canned aggregate.
 *
 * The one prior test that only asserted the built SQL string ("now is
 * bound 4 times in this exact param order") is dropped per the
 * inventory's own guidance -- a live client has no "what SQL was I sent"
 * introspection point, and "seed jobs at known timestamps, assert the
 * returned counts" (covered by the tests below) is a strictly stronger
 * test of the same date-window logic.
 *
 * Every test uses a `test-crs-`-prefixed slug/board-token (`crs` =
 * company-role-stats, this file) and deletes its own rows in a `finally`
 * (FK-safe order: jobs -> sources -> companies), per AGENTS.md's "shared
 * instance, not isolated" -- this is the same dev D1 database
 * `seed-local-d1.sql` and the ops scripts operate on, so a leftover row
 * from a failed test run is a real, visible cost, not a throwaway
 * fixture. `afterEach` is a belt-and-suspenders second cleanup pass (in
 * case a `finally` itself never ran, e.g. a hard process kill) that
 * deletes anything still tagged with this file's test-id prefix.
 */

const TEST_PREFIX = "test-crs";
let seq = 0;
function testId(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** Deletes everything under one seeded company, FK-safe order, all 3
 * statements in one client.batch() call -- D1's real atomicity
 * primitive (see lib/d1/client.ts's batch() header comment; D1 has no
 * BEGIN/COMMIT SQL surface via the Workers binding) -- so a mid-sequence
 * process kill can't leave this company's rows half-deleted (data-
 * integrity concern, 2026-08-02). */
async function cleanupCompany(companyId: string, sourceId: string): Promise<void> {
  await client.batch([
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM sources WHERE id = ?`, params: [sourceId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
}

/** Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` (hard kill, etc.) -- matches on the
 * shared TEST_PREFIX rather than a specific id. Same batch() atomicity
 * reasoning as cleanupCompany above. */
afterEach(async () => {
  await client.batch([
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

async function seedCompanyAndSource(label: string) {
  const slug = testId(label);
  const company = await createCompany(client, { slug, displayName: `Test CRS ${slug}` });
  const source = await createSource(client, {
    companyId: company.id,
    provider: "greenhouse",
    boardToken: slug,
    publicUrl: `https://example.invalid/${slug}`,
  });
  return { company, source };
}

/** Minimal upsertJob input for a job at a given first_seen_at, via
 * `observedAt` (upsertJob sets first_seen_at = observedAt for a new
 * row -- see jobs-repo.ts). */
async function seedJob(
  companyId: string,
  sourceId: string,
  externalJobId: string,
  observedAt: string,
): Promise<void> {
  await upsertJob(client, {
    sourceId,
    companyId,
    externalJobId,
    canonicalUrl: `https://example.invalid/jobs/${externalJobId}`,
    title: "Security Engineer",
    titleNormalized: "security engineer",
    contentHash: `hash-${externalJobId}`,
    observedAt,
  });
}

describe("getCompanyRoleActivityStats", () => {
  it("returns all zeros when no jobs exist for this company+role", async () => {
    const { company, source } = await seedCompanyAndSource("zeros");
    try {
      const result = await getCompanyRoleActivityStats(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        now: "2026-07-29T00:00:00Z",
      });
      expect(result).toEqual({
        activeMatchingCount: 0,
        newInLast14Days: 0,
        newInPrior56Days: 0,
        distinctLocationCount: 0,
      });
    } finally {
      await cleanupCompany(company.id, source.id);
    }
  });

  it("counts active jobs and buckets first_seen_at into the 14-day / prior-56-day windows", async () => {
    const { company, source } = await seedCompanyAndSource("windows");
    try {
      const now = "2026-07-29T00:00:00.000Z";
      // Inside the last-14-days window (now - 7d).
      await seedJob(company.id, source.id, "job-recent", "2026-07-22T00:00:00.000Z");
      // Inside the prior-56-day window (now - 30d, i.e. before the
      // 14-day cutoff but within 70 days of now).
      await seedJob(company.id, source.id, "job-older", "2026-06-29T00:00:00.000Z");
      // Outside both windows entirely (now - 100d).
      await seedJob(company.id, source.id, "job-ancient", "2026-04-20T00:00:00.000Z");

      // upsertJob leaves role_primary NULL (classification runs
      // separately, per jobs-repo.ts's own header comment) -- set it
      // directly so these rows match the role_category filter under
      // test, without pulling the classifier into this test's scope.
      await client.run(`UPDATE jobs SET role_primary = 'cybersecurity' WHERE source_id = ?`, [
        source.id,
      ]);

      const result = await getCompanyRoleActivityStats(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        now,
      });

      expect(result.activeMatchingCount).toBe(3); // all 3 default to status='active'
      expect(result.newInLast14Days).toBe(1); // job-recent only
      expect(result.newInPrior56Days).toBe(1); // job-older only
    } finally {
      await cleanupCompany(company.id, source.id);
    }
  });

  it("only counts jobs matching role_category, ignoring other roles for the same company", async () => {
    const { company, source } = await seedCompanyAndSource("role-filter");
    try {
      await seedJob(company.id, source.id, "job-cyber", "2026-07-25T00:00:00.000Z");
      await seedJob(company.id, source.id, "job-swe", "2026-07-25T00:00:00.000Z");
      await client.run(
        `UPDATE jobs SET role_primary = 'cybersecurity' WHERE source_id = ? AND external_job_id = ?`,
        [source.id, "job-cyber"],
      );
      await client.run(
        `UPDATE jobs SET role_primary = 'software_engineering' WHERE source_id = ? AND external_job_id = ?`,
        [source.id, "job-swe"],
      );

      const result = await getCompanyRoleActivityStats(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        now: "2026-07-29T00:00:00.000Z",
      });

      expect(result.activeMatchingCount).toBe(1);
    } finally {
      await cleanupCompany(company.id, source.id);
    }
  });

  it("distinctLocationCount counts distinct (country/region/city/mode) tuples among active matching jobs only", async () => {
    const { company, source } = await seedCompanyAndSource("locations");
    try {
      // Two jobs in the same location tuple -> 1 distinct location.
      await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-loc-1a",
        canonicalUrl: "https://example.invalid/jobs/job-loc-1a",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-loc-1a",
        observedAt: "2026-07-25T00:00:00.000Z",
        locationMode: "remote",
        countryCode: "US",
        regionCode: "CA",
        city: "San Francisco",
      });
      await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-loc-1b",
        canonicalUrl: "https://example.invalid/jobs/job-loc-1b",
        title: "Security Engineer II",
        titleNormalized: "security engineer ii",
        contentHash: "hash-loc-1b",
        observedAt: "2026-07-25T00:00:00.000Z",
        locationMode: "remote",
        countryCode: "US",
        regionCode: "CA",
        city: "San Francisco",
      });
      // A distinct location tuple -> +1 distinct location.
      await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-loc-2",
        canonicalUrl: "https://example.invalid/jobs/job-loc-2",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-loc-2",
        observedAt: "2026-07-25T00:00:00.000Z",
        locationMode: "onsite",
        countryCode: "DE",
        regionCode: "BE",
        city: "Berlin",
      });
      await client.run(`UPDATE jobs SET role_primary = 'cybersecurity' WHERE source_id = ?`, [
        source.id,
      ]);
      // A closed job at a third, otherwise-unseen location -- must NOT
      // count, since distinctLocationCount only considers active/
      // possibly_closed jobs (same population as activeMatchingCount).
      await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-loc-closed",
        canonicalUrl: "https://example.invalid/jobs/job-loc-closed",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-loc-closed",
        observedAt: "2026-07-25T00:00:00.000Z",
        locationMode: "onsite",
        countryCode: "FR",
        regionCode: "IDF",
        city: "Paris",
      });
      await client.run(
        `UPDATE jobs SET role_primary = 'cybersecurity', status = 'closed' WHERE source_id = ? AND external_job_id = ?`,
        [source.id, "job-loc-closed"],
      );

      const result = await getCompanyRoleActivityStats(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        now: "2026-07-29T00:00:00.000Z",
      });

      expect(result.distinctLocationCount).toBe(2);
      expect(result.activeMatchingCount).toBe(3); // the 3 active jobs, not the closed one
    } finally {
      await cleanupCompany(company.id, source.id);
    }
  });
});
