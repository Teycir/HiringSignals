import { afterAll, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource } from "../src/sources-repo";
import { upsertJob } from "../src/jobs-repo";
import { createSignal, appendSignalEvidence } from "../src/signals-write-repo";
import { listSignalsForExport } from "../src/signals-repo";

/**
 * Milestone L.1 (ROADMAP.md) -- listSignalsForExport, the CSV export
 * repo function backing `GET /api/v1/export/signals.csv`. Split into its
 * own file (rather than added to signals-repo.test.ts) since it's new
 * coverage for one function, keeping this file's seed/assert shape easy
 * to scan on its own -- same "one concern per file" reasoning as
 * company-role-stats-repo.test.ts living apart from signals-repo.test.ts.
 *
 * Live-D1 only, per AGENTS.md's "zero mocks, zero fakes" policy: every
 * test seeds real companies/sources/jobs/signals/signal_evidence rows via
 * the real repo write paths, calls the real listSignalsForExport, and
 * asserts on its real return value.
 *
 * Every test uses a `test-ser-`-prefixed company slug (`ser` =
 * signals-export-repo, this file) and cleans up in a `finally`
 * (FK-safe order: signal_evidence -> signals -> jobs -> source_runs ->
 * sources -> companies), with an `afterAll` sweep as a second pass,
 * matching signals-repo.test.ts's discipline.
 *
 * `source_runs` added before `sources` (2026-08-05) -- this file's
 * `createSource` calls don't write `source_runs` directly (confirmed:
 * only `openSourceRun`-style functions in sources-repo.ts do, never
 * called here), and this file's own tests all passed individually
 * before this fix -- the failure was every run's cleanup, not the
 * assertions -- but the identical `FOREIGN KEY constraint failed` this
 * repo already reproduced and fixed in company-role-stats-repo.test.ts
 * (see that file's cleanupCompany comment for the full isolation
 * trace) applies here too: whatever writes a leftover `source_runs`
 * row isn't yet pinned down, but the row and the FK it violates are
 * real, so deleting it first is correct regardless. `afterEach` moved
 * to `afterAll` for the same reason as that file and
 * ingest-consumer.test.ts (2026-08-04) -- a global-prefix sweep
 * belongs at the end of the file, not racing sibling tests mid-suite.
 */

const TEST_PREFIX = "test-ser";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** All 6 statements run in one client.batch() call -- D1's real
 * atomicity primitive (see lib/d1/client.ts's batch() header comment;
 * D1 has no BEGIN/COMMIT SQL surface via the Workers binding) -- so a
 * mid-sequence process kill can't leave this company's rows
 * half-deleted (data-integrity concern, 2026-08-02). */
async function cleanupCompany(companyId: string): Promise<void> {
  await client.batch([
    {
      sql: `DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM signals WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM sources WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
}

/** Same batch() atomicity reasoning as cleanupCompany above. Runs in
 * `afterAll`, not `afterEach` -- see this file's header comment for
 * why. */
afterAll(async () => {
  await client.batch([
    {
      sql: `DELETE FROM signal_evidence WHERE signal_id IN (
         SELECT id FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
       )`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (
         SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
       )`,
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

describe("listSignalsForExport", () => {
  it("includes the representative job's canonical_url/location_mode/country_code/source_platform", async () => {
    const company = await seedCompany("job-fields", "Job Fields Export Co");
    try {
      const source = await createSource(client, {
        companyId: company.id,
        provider: "greenhouse",
        boardToken: company.slug,
        publicUrl: `https://example.invalid/${company.slug}`,
      });
      const now = new Date().toISOString();
      const job = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-1",
        canonicalUrl: "https://example.invalid/jobs/job-1",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-1",
        observedAt: now,
        locationMode: "remote",
        countryCode: "US",
      });
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 80,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "New role",
        summary: "New role summary.",
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      const result = await listSignalsForExport(client, { company: company.slug, minScore: 0 });
      expect(result.items).toHaveLength(1);
      const row = result.items[0];
      expect(row?.canonical_url).toBe("https://example.invalid/jobs/job-1");
      expect(row?.location_mode).toBe("remote");
      expect(row?.country_code).toBe("US");
      expect(row?.source_platform).toBe("greenhouse");
      expect(result.truncated).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns null job-derived fields for a company-level signal with no job-linked evidence", async () => {
    const company = await seedCompany("no-job", "No Job Export Co");
    try {
      const now = new Date().toISOString();
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "hiring_burst",
        score: 75,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "Hiring burst",
        summary: "Company-level burst.",
      });
      // Aggregate evidence, no job_id -- exercises the LEFT JOIN's
      // all-null branch (Milestone H.4 company-level signals).
      await appendSignalEvidence(client, {
        signalId,
        jobId: null,
        evidenceType: "hiring_burst_aggregate",
        observedAt: now,
        payload: { count: 5 },
      });

      const result = await listSignalsForExport(client, { company: company.slug, minScore: 0 });
      expect(result.items).toHaveLength(1);
      const row = result.items[0];
      expect(row?.canonical_url).toBeNull();
      expect(row?.location_mode).toBeNull();
      expect(row?.country_code).toBeNull();
      expect(row?.source_platform).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("picks the most-recently-observed job when a signal has multiple evidence rows", async () => {
    const company = await seedCompany("multi-evidence", "Multi Evidence Export Co");
    try {
      const source = await createSource(client, {
        companyId: company.id,
        provider: "lever",
        boardToken: company.slug,
        publicUrl: `https://example.invalid/${company.slug}`,
      });
      const now = new Date();
      const earlier = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
      const later = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const jobA = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-a",
        canonicalUrl: "https://example.invalid/jobs/job-a",
        title: "Role A",
        titleNormalized: "role a",
        contentHash: "hash-job-a",
        observedAt: earlier,
      });
      const jobB = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-b",
        canonicalUrl: "https://example.invalid/jobs/job-b",
        title: "Role B",
        titleNormalized: "role b",
        contentHash: "hash-job-b",
        observedAt: later,
      });
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "hiring_burst",
        score: 60,
        scoreVersion: "v1",
        detectedAt: later,
        headline: "Burst",
        summary: "Burst summary.",
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: jobA.id,
        evidenceType: "new_job_posting",
        observedAt: earlier,
        payload: {},
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: jobB.id,
        evidenceType: "new_job_posting",
        observedAt: later,
        payload: {},
      });

      const result = await listSignalsForExport(client, { company: company.slug, minScore: 0, observedSince: earlier });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.canonical_url).toBe("https://example.invalid/jobs/job-b");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("applies the same roles/minScore filters as listSignals", async () => {
    const company = await seedCompany("filters", "Filters Export Co");
    try {
      const now = new Date().toISOString();
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 90,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "High score",
        summary: "High score summary.",
      });
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 20,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "Low score",
        summary: "Low score summary.",
      });

      const result = await listSignalsForExport(client, {
        company: company.slug,
        roles: ["cybersecurity"],
        minScore: 50,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.headline).toBe("High score");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by score DESC, matching listSignals' default order", async () => {
    const company = await seedCompany("order", "Order Export Co");
    try {
      const now = new Date().toISOString();
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 30,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "Low",
        summary: "Low.",
      });
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 95,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "High",
        summary: "High.",
      });

      const result = await listSignalsForExport(client, { company: company.slug, minScore: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.score).toBe(95);
      expect(result.items[1]?.score).toBe(30);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});
