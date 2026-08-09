import { afterAll, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource } from "../src/sources-repo";
import { upsertJob } from "../src/jobs-repo";
import { getHiringTrends } from "../src/trends-repo";

/**
 * Live-D1 tests for getHiringTrends (ROADMAP.md Milestone P.2), same
 * pattern as company-role-stats-repo.test.ts's own header comment:
 * real rows seeded through real repo functions (createCompany,
 * createSource, upsertJob), no fakes/mocks (AGENTS.md's zero-mocks
 * policy). `test-trends-`-prefixed slugs/board-tokens, FK-safe cleanup
 * in `finally` + a belt-and-suspenders `afterAll` prefix sweep.
 *
 * Per-test timeout overrides (2026-08-09, added after this file's first
 * live run): this package's vitest.config.ts sets a 90s file-level
 * default (see that file's header comment), sized for the sibling
 * company-role-stats-repo.test.ts's smaller per-test seed counts. Tests
 * below that seed 2 companies x up to 5 jobs each (~10 seeded jobs,
 * ~24 live `npx wrangler d1 execute` round trips once createCompany/
 * createSource/upsertJob's own multi-call internals are counted) exceed
 * that 90s budget at this session's observed ~4-9s-per-call cost --
 * confirmed directly: those exact tests timed out at 90000ms on first
 * run, while the one test seeding a single job passed comfortably
 * inside 90s. Same "raise per-test, don't lower the file default"
 * approach ROADMAP.md's ingest-consumer.test.ts fixes already used.
 */

const TEST_PREFIX = "test-trends";
let seq = 0;
function testId(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

async function cleanupCompany(companyId: string, sourceId: string): Promise<void> {
  await client.batch([
    { sql: `DELETE FROM signals WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM source_runs WHERE source_id = ?`, params: [sourceId] },
    { sql: `DELETE FROM sources WHERE id = ?`, params: [sourceId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
}

afterAll(async () => {
  await client.batch([
    {
      sql: `DELETE FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?))`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    { sql: `DELETE FROM companies WHERE slug LIKE ?`, params: [`${TEST_PREFIX}-%`] },
  ]);
});

async function seedCompanyAndSource(label: string, industry?: string) {
  const slug = testId(label);
  const company = await createCompany(client, { slug, displayName: `Test Trends ${slug}`, industry });
  const source = await createSource(client, {
    companyId: company.id,
    provider: "greenhouse",
    boardToken: slug,
    publicUrl: `https://example.invalid/${slug}`,
  });
  return { company, source };
}

async function seedJob(
  companyId: string,
  sourceId: string,
  externalJobId: string,
  observedAt: string,
  countryCode = "US",
): Promise<void> {
  await upsertJob(client, {
    sourceId,
    companyId,
    externalJobId,
    canonicalUrl: `https://example.invalid/jobs/${externalJobId}`,
    title: "ML Engineer",
    titleNormalized: "ml engineer",
    contentHash: `hash-${externalJobId}`,
    observedAt,
    countryCode,
  });
  await client.run(
    `UPDATE jobs SET role_primary = 'ai_machine_learning' WHERE source_id = ? AND external_job_id = ?`,
    [sourceId, externalJobId],
  );
}
describe("getHiringTrends", () => {
  it(
    "ranks companies by acceleration_desc by default, higher-volume-recent company first",
    async () => {
      const now = new Date().toISOString();
      const fast = await seedCompanyAndSource("fast", "fintech");
      const slow = await seedCompanyAndSource("slow", "fintech");
      try {
        // fast: 4 new jobs in the last 14 days, none before -- high acceleration.
        for (let i = 0; i < 4; i++) {
          await seedJob(fast.company.id, fast.source.id, `fast-${i}`, now);
        }
        // slow: 1 new job in the last 14 days, several in the prior window --
        // acceleration should be low/negative relative to fast.
        await seedJob(slow.company.id, slow.source.id, "slow-recent", now);
        for (let i = 0; i < 4; i++) {
          const daysAgo = new Date(Date.now() - (20 + i * 5) * 24 * 60 * 60 * 1000).toISOString();
          await seedJob(slow.company.id, slow.source.id, `slow-older-${i}`, daysAgo);
        }

        const results = await getHiringTrends(client, {
          roleCategoryFilter: ["ai_machine_learning"],
          since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          limit: 20,
          sort: "acceleration_desc",
        });

        const fastResult = results.find((r) => r.company.slug === fast.company.slug);
        const slowResult = results.find((r) => r.company.slug === slow.company.slug);
        expect(fastResult).toBeDefined();
        expect(slowResult).toBeDefined();
        expect(fastResult!.acceleration).toBeGreaterThan(slowResult!.acceleration);
        // Confirm ordering: fast ranks strictly before slow in the array.
        expect(results.indexOf(fastResult!)).toBeLessThan(results.indexOf(slowResult!));
      } finally {
        await cleanupCompany(fast.company.id, fast.source.id);
        await cleanupCompany(slow.company.id, slow.source.id);
      }
    },
    240_000,
  );

  it(
    "filters by industry, excluding companies outside the requested industry",
    async () => {
      const now = new Date().toISOString();
      const inIndustry = await seedCompanyAndSource("in-industry", "healthtech");
      const outOfIndustry = await seedCompanyAndSource("out-industry", "defense");
      try {
        await seedJob(inIndustry.company.id, inIndustry.source.id, "in-job", now);
        await seedJob(outOfIndustry.company.id, outOfIndustry.source.id, "out-job", now);

        const results = await getHiringTrends(client, {
          roleCategoryFilter: ["ai_machine_learning"],
          industryFilter: "healthtech",
          since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          limit: 20,
          sort: "volume_desc",
        });

        expect(results.some((r) => r.company.slug === inIndustry.company.slug)).toBe(true);
        expect(results.some((r) => r.company.slug === outOfIndustry.company.slug)).toBe(false);
      } finally {
        await cleanupCompany(inIndustry.company.id, inIndustry.source.id);
        await cleanupCompany(outOfIndustry.company.id, outOfIndustry.source.id);
      }
    },
    150_000,
  );

  it(
    "volume_desc sorts by newJobsCount within the since window",
    async () => {
      const now = new Date().toISOString();
      const highVolume = await seedCompanyAndSource("high-vol", "fintech");
      const lowVolume = await seedCompanyAndSource("low-vol", "fintech");
      try {
        for (let i = 0; i < 5; i++) {
          await seedJob(highVolume.company.id, highVolume.source.id, `hv-${i}`, now);
        }
        await seedJob(lowVolume.company.id, lowVolume.source.id, "lv-0", now);

        const results = await getHiringTrends(client, {
          roleCategoryFilter: ["ai_machine_learning"],
          since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          limit: 20,
          sort: "volume_desc",
        });

        const hvResult = results.find((r) => r.company.slug === highVolume.company.slug);
        const lvResult = results.find((r) => r.company.slug === lowVolume.company.slug);
        expect(hvResult!.newJobsCount).toBe(5);
        expect(lvResult!.newJobsCount).toBe(1);
        expect(results.indexOf(hvResult!)).toBeLessThan(results.indexOf(lvResult!));
      } finally {
        await cleanupCompany(highVolume.company.id, highVolume.source.id);
        await cleanupCompany(lowVolume.company.id, lowVolume.source.id);
      }
    },
    240_000,
  );

  it(
    "returns topLocations capped and counted per company",
    async () => {
      const now = new Date().toISOString();
      const { company, source } = await seedCompanyAndSource("locations", "fintech");
      try {
        await seedJob(company.id, source.id, "loc-us-1", now, "US");
        await seedJob(company.id, source.id, "loc-us-2", now, "US");
        await seedJob(company.id, source.id, "loc-de-1", now, "DE");

        const results = await getHiringTrends(client, {
          roleCategoryFilter: ["ai_machine_learning"],
          since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          limit: 20,
          sort: "volume_desc",
        });

        const result = results.find((r) => r.company.slug === company.slug);
        expect(result).toBeDefined();
        const us = result!.topLocations.find((l) => l.countryCode === "US");
        const de = result!.topLocations.find((l) => l.countryCode === "DE");
        expect(us?.count).toBe(2);
        expect(de?.count).toBe(1);
      } finally {
        await cleanupCompany(company.id, source.id);
      }
    },
    150_000,
  );

  it("excludes companies with zero new jobs in the since window", async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const { company, source } = await seedCompanyAndSource("stale", "fintech");
    try {
      await seedJob(company.id, source.id, "stale-job", oldDate);

      const results = await getHiringTrends(client, {
        roleCategoryFilter: ["ai_machine_learning"],
        since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        limit: 20,
        sort: "acceleration_desc",
      });

      expect(results.some((r) => r.company.slug === company.slug)).toBe(false);
    } finally {
      await cleanupCompany(company.id, source.id);
    }
  });
});
