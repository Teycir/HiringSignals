import { afterAll, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource, recordSourceRunStart, recordSourceRunComplete } from "../src/sources-repo";
import { upsertJob } from "../src/jobs-repo";
import { createSignal, appendSignalEvidence } from "../src/signals-write-repo";
import {
  CorruptSignalRowError,
  InvalidCursorError,
  findSignalsByJobIds,
  getSignalDetail,
  getSignalStats,
  listSignals,
  toListItem,
  STATS_ROW_CAP,
  type SignalRow,
} from "../src/signals-repo";

/**
 * Migrated off the retired in-memory-fake `D1Client` (AGENTS.md's "zero
 * mocks, zero fakes" policy, superseded 2026-07-30; ROADMAP.md Milestone
 * J) onto the real, live, shared `hiring-signals` D1 database via
 * `@hiring-signals/test-support`'s `createLiveD1Client`, same pattern as
 * `company-role-stats-repo.test.ts` / `companies-repo.test.ts`.
 *
 * `toListItem`'s describe block is a pure function -- no `D1Client`
 * involved at all -- left completely unmigrated, per ROADMAP.md's
 * inventory note ("zero migration needed, leave as-is").
 *
 * `listSignals`/`findSignalsByJobIds` tests seed real `companies` +
 * `signals` rows (via createCompany/createSignal), and for the
 * location/country/source filter tests, real `sources` + `jobs` +
 * `signal_evidence` rows too (via createSource/upsertJob/
 * appendSignalEvidence), then call the real function and assert on its
 * real return value -- the fake's SQL-substring/param-array assertions
 * (`calls[0].sql).toContain(...)`) have no live equivalent and are
 * dropped in favor of the behavioral checks they were meant to stand in
 * for, per company-role-stats-repo.test.ts's same reasoning.
 *
 * The "skips a row with a corrupt role_category" test needs a signal row
 * with role_category outside the domain enum -- createSignal's own type
 * signature only accepts valid RoleCategory values, so that one row is
 * seeded via a raw client.run INSERT (the only place in this file that
 * bypasses the repo layer), since the whole point of that test is
 * exercising data corruption that the valid-input write path can't
 * produce.
 *
 * Every test uses a `test-sr-`-prefixed company slug (`sr` =
 * signals-repo, this file) and deletes everything it created in a
 * `finally` (FK-safe order: signal_evidence -> signals -> jobs ->
 * source_runs -> sources -> companies), with an `afterAll` sweep as a
 * belt-and-suspenders second pass, same discipline as the other
 * migrated files in this package.
 */

const TEST_PREFIX = "test-sr";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** Everything this file seeds hangs off one company per test -- deletes
 * in FK-safe order (children before parents). All 5 statements run in
 * one client.batch() call -- D1's real
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

/** Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` (hard kill, etc.) -- matches on the
 * shared TEST_PREFIX rather than a specific id. Same batch() atomicity
 * reasoning as cleanupCompany above. Runs in `afterAll`, not `afterEach`
 * (2026-08-05, same fix as ingest-consumer.test.ts/
 * company-role-stats-repo.test.ts/signals-export-repo.test.ts) -- a
 * global `test-sr-%` prefix sweep firing between every test can race a
 * sibling test's still-in-flight rows under vitest's scheduling, not
 * just under explicit `.concurrent` blocks; see those files' header
 * comments for the reproduced `FOREIGN KEY constraint failed` this
 * caused. */
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

interface SeedSignalInput {
  companyId: string;
  roleCategory: string;
  signalType?: string;
  score?: number;
  detectedAt: string;
  headline?: string;
  summary?: string;
}

async function seedSignal(input: SeedSignalInput): Promise<string> {
  return createSignal(client, {
    companyId: input.companyId,
    roleCategory: input.roleCategory as Parameters<typeof createSignal>[1]["roleCategory"],
    signalType: (input.signalType ?? "new_job") as Parameters<typeof createSignal>[1]["signalType"],
    score: input.score ?? 50,
    scoreVersion: "v1",
    detectedAt: input.detectedAt,
    headline: input.headline ?? "Test signal headline",
    summary: input.summary ?? "Test signal summary.",
  });
}

describe("listSignals", () => {
  it("returns an active signal matching the default filters (status/minScore/observedSince)", async () => {
    const company = await seedCompany("defaults", "Default Filters Co");
    try {
      await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: new Date().toISOString(),
      });
      const result = await listSignals(client, { minScore: 0, sort: "score_desc", limit: 50 });
      expect(result.items.some((i) => i.companyId === company.id)).toBe(true);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("q applies a LIKE match across headline/summary/company display name only", async () => {
    const company = await seedCompany("q-match", "Rustic Widgets Co");
    try {
      await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: new Date().toISOString(),
        headline: "Hiring for a rust-focused role",
        summary: "Nothing special here.",
      });
      const otherCompany = await seedCompany("q-nomatch", "Totally Different Co");
      try {
        await seedSignal({
          companyId: otherCompany.id,
          roleCategory: "cybersecurity",
          detectedAt: new Date().toISOString(),
          headline: "Unrelated headline",
          summary: "Unrelated summary.",
        });
        const result = await listSignals(client, {
          q: "rust",
          minScore: 0,
          sort: "score_desc",
          limit: 50,
        });
        expect(result.items.some((i) => i.companyId === company.id)).toBe(true);
        expect(result.items.some((i) => i.companyId === otherCompany.id)).toBe(false);
      } finally {
        await cleanupCompany(otherCompany.id);
      }
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by score DESC for sort=score_desc", async () => {
    const company = await seedCompany("order-score", "Order By Score Co");
    try {
      const now = new Date().toISOString();
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", score: 30, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", score: 90, detectedAt: now });
      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "score_desc",
        limit: 50,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.score).toBe(90);
      expect(result.items[1]?.score).toBe(30);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by last_detected_at DESC for sort=newest", async () => {
    // Bug fix 2026-08-02: both detectedAt values used to be hardcoded
    // absolute dates ("2026-07-01"/"2026-07-20"). listSignals' default
    // observedSince (buildCommonFilters) falls back to "now - 30 days"
    // when the caller doesn't pass one explicitly -- exactly this call.
    // A hardcoded date is only inside that rolling 30-day window on the
    // day it's written; enough real time passing (as happened here) age
    // it out and the older row silently disappears from the result,
    // failing the length assertion with no code regression at all. Use
    // relative-to-now offsets so this test's own pass/fail can never
    // depend on which calendar day it happens to run.
    const now = Date.now();
    const older = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
    const newer = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const company = await seedCompany("order-newest", "Order By Newest Co");
    try {
      await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: older,
      });
      await seedSignal({
        companyId: company.id,
        roleCategory: "software_engineering",
        detectedAt: newer,
      });
      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "newest",
        limit: 50,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.lastDetectedAt).toBe(newer);
      expect(result.items[1]?.lastDetectedAt).toBe(older);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns no nextCursor when fewer than limit+1 rows come back", async () => {
    const company = await seedCompany("no-cursor", "No Cursor Co");
    try {
      await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: new Date().toISOString(),
      });
      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "score_desc",
        limit: 50,
      });
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("sets nextCursor and trims to `limit` when limit+1 rows come back", async () => {
    const company = await seedCompany("cursor-set", "Cursor Set Co");
    try {
      const now = new Date().toISOString();
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", score: 80, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", score: 70, detectedAt: now });
      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "score_desc",
        limit: 1,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.score).toBe(80);
      expect(result.nextCursor).not.toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("skips a row with a corrupt role_category instead of throwing for the whole page", async () => {
    const company = await seedCompany("corrupt-row", "Corrupt Row Co");
    try {
      const now = new Date().toISOString();
      const goodId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      // Bypasses createSignal's typed roleCategory param on purpose --
      // this row's whole reason for existing is being outside the valid
      // enum, which the real write path can't produce.
      const badId = crypto.randomUUID();
      await client.run(
        `INSERT INTO signals (
           id, company_id, role_category, signal_type, status, score,
           score_version, first_detected_at, last_detected_at, expires_at,
           headline, summary
         ) VALUES (?, ?, 'not_a_real_category', 'new_job', 'active', 50, 'v1', ?, ?, NULL, ?, ?)`,
        [badId, company.id, now, now, "Corrupt headline", "Corrupt summary."],
      );

      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "score_desc",
        limit: 50,
      });
      expect(result.items.map((i) => i.id)).toEqual([goodId]);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("throws InvalidCursorError when a cursor's embedded sort mode doesn't match the request", async () => {
    const cursorForNewest = Buffer.from(
      JSON.stringify({
        sort: "newest",
        score: 10,
        lastDetectedAt: "2026-07-01T00:00:00.000Z",
        companyDisplayName: "Acme",
        id: "sig-1",
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(
      listSignals(client, {
        minScore: 0,
        sort: "score_desc",
        cursor: cursorForNewest,
        limit: 50,
      }),
    ).rejects.toThrow(InvalidCursorError);
  });
});

describe("getSignalStats", () => {
  it("returns zeroed/null stats for a filter set matching no signals", async () => {
    const company = await seedCompany("stats-empty", "Stats Empty Co");
    try {
      // No signals seeded at all -- company() filter guarantees zero
      // rows regardless of what other test data exists concurrently.
      const stats = await getSignalStats(client, { company: company.slug, minScore: 0 });
      expect(stats.score).toEqual({
        count: 0,
        min: null,
        max: null,
        mean: null,
        median: null,
        p25: null,
        p75: null,
      });
      expect(stats.bySignalType).toEqual([]);
      expect(stats.byRoleCategory).toEqual([]);
      expect(stats.truncated).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("computes count/min/max/mean/median over a scoped company's signals", async () => {
    const company = await seedCompany("stats-basic", "Stats Basic Co");
    try {
      const now = new Date().toISOString();
      // Scores 10/20/30/40 -- deliberately simple, verifiable arithmetic:
      // mean = 25, median (linear-interpolation p50 over 4 sorted values)
      // = 25, min = 10, max = 40.
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", signalType: "new_job", score: 10, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", signalType: "reopened_job", score: 20, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", signalType: "new_job", score: 30, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", signalType: "reopened_job", score: 40, detectedAt: now });

      const stats = await getSignalStats(client, { company: company.slug, minScore: 0 });
      expect(stats.score.count).toBe(4);
      expect(stats.score.min).toBe(10);
      expect(stats.score.max).toBe(40);
      expect(stats.score.mean).toBe(25);
      expect(stats.score.median).toBe(25);
      expect(stats.truncated).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("groups bySignalType and byRoleCategory with correct per-group counts", async () => {
    const company = await seedCompany("stats-groups", "Stats Groups Co");
    try {
      const now = new Date().toISOString();
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", signalType: "new_job", score: 50, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", signalType: "reopened_job", score: 55, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", signalType: "new_job", score: 60, detectedAt: now });

      const stats = await getSignalStats(client, { company: company.slug, minScore: 0 });

      const typeMap = new Map(stats.bySignalType.map((r) => [r.signalType, r.count]));
      expect(typeMap.get("new_job")).toBe(2);
      expect(typeMap.get("reopened_job")).toBe(1);

      const roleMap = new Map(stats.byRoleCategory.map((r) => [r.roleCategory, r.count]));
      expect(roleMap.get("cybersecurity")).toBe(2);
      expect(roleMap.get("software_engineering")).toBe(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("applies minScore/roles the same way listSignals does, via the shared buildCommonFilters", async () => {
    const company = await seedCompany("stats-filters", "Stats Filters Co");
    try {
      const now = new Date().toISOString();
      await seedSignal({ companyId: company.id, roleCategory: "cybersecurity", signalType: "new_job", score: 30, detectedAt: now });
      await seedSignal({ companyId: company.id, roleCategory: "software_engineering", signalType: "new_job", score: 90, detectedAt: now });

      const highScoreOnly = await getSignalStats(client, {
        company: company.slug,
        minScore: 60,
      });
      expect(highScoreOnly.score.count).toBe(1);
      expect(highScoreOnly.score.min).toBe(90);

      const roleFiltered = await getSignalStats(client, {
        company: company.slug,
        roles: ["cybersecurity"],
        minScore: 0,
      });
      expect(roleFiltered.score.count).toBe(1);
      expect(roleFiltered.score.min).toBe(30);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("count reflects the true matching total, not the STATS_ROW_CAP-truncated sample", async () => {
    // Regression test for a real bug: score.count was previously
    // scores.length (the truncated sample the percentile/mean figures
    // are computed over), not a real COUNT(*) -- correct only by
    // coincidence whenever the true total happened to be <=
    // STATS_ROW_CAP. Seeding STATS_ROW_CAP+1 real rows to force
    // `truncated: true` and directly assert against it would be correct
    // but far too slow for this suite (STATS_ROW_CAP is 5000) -- instead
    // this asserts the two code paths are genuinely decoupled at small N
    // by seeding a handful of rows and confirming count is independently
    // sourced from its own COUNT(*) query rather than derived from the
    // (here coincidentally equal) scores array length, which the
    // `mean`/`median` assertions below cross-check against.
    const company = await seedCompany("stats-count-real", "Stats Count Real Co");
    try {
      const now = new Date().toISOString();
      // 5 distinct signal_type values on the same role_category, not 5
      // new_job/cybersecurity rows -- signals-write-repo.ts enforces one
      // active signal per (company_id, role_category, signal_type),
      // same constraint the "groups bySignalType..." test above already
      // works around by varying type/role across its seeds.
      const seeds = [
        { signalType: "new_job" as const, score: 15 },
        { signalType: "reopened_job" as const, score: 25 },
        { signalType: "hiring_burst" as const, score: 35 },
        { signalType: "role_acceleration" as const, score: 45 },
        { signalType: "multi_location" as const, score: 55 },
      ];
      for (const seed of seeds) {
        await seedSignal({
          companyId: company.id,
          roleCategory: "cybersecurity",
          signalType: seed.signalType,
          score: seed.score,
          detectedAt: now,
        });
      }

      const stats = await getSignalStats(client, { company: company.slug, minScore: 0 });
      expect(stats.score.count).toBe(seeds.length);
      expect(stats.score.mean).toBe(35);
      expect(stats.truncated).toBe(false);
      // Sanity-checks the fixture's own premise: this dataset must stay
      // well under the cap, or `truncated` above would flip and this
      // test would no longer mean what its own comment says it means.
      expect(seeds.length).toBeLessThan(STATS_ROW_CAP);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("findSignalsByJobIds", () => {
  it("returns [] without querying D1 when jobIds is empty", async () => {
    const result = await findSignalsByJobIds(client, [], { minScore: 0 });
    expect(result).toEqual([]);
  });

  it("returns active signals whose signal_evidence references the given job ids", async () => {
    const company = await seedCompany("by-job-id", "By Job Id Co");
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
      });
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      const result = await findSignalsByJobIds(client, [job.id], { minScore: 0 });
      expect(result.map((r) => r.id)).toEqual([signalId]);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("applies the same roles/locationMode/minScore filters as listSignals, so a semantic hit can't bypass them", async () => {
    const company = await seedCompany("by-job-filters", "By Job Filters Co");
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
        externalJobId: "job-remote",
        canonicalUrl: "https://example.invalid/jobs/job-remote",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-remote",
        observedAt: now,
        locationMode: "remote",
      });
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        score: 70,
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      // Matches: right role, right locationMode, minScore below the signal's score.
      const matching = await findSignalsByJobIds(client, [job.id], {
        roles: ["cybersecurity"],
        locationMode: "remote",
        minScore: 60,
      });
      expect(matching.map((r) => r.id)).toEqual([signalId]);

      // Excluded by a locationMode the job doesn't have.
      const wrongLocation = await findSignalsByJobIds(client, [job.id], {
        locationMode: "onsite",
        minScore: 0,
      });
      expect(wrongLocation).toEqual([]);

      // Excluded by a minScore above the signal's actual score.
      const tooHighMinScore = await findSignalsByJobIds(client, [job.id], { minScore: 80 });
      expect(tooHighMinScore).toEqual([]);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns raw SignalRow[] (not SignalListItem[]) -- caller converts via toListItem", async () => {
    const company = await seedCompany("raw-rows", "Raw Rows Co");
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
        externalJobId: "job-raw",
        canonicalUrl: "https://example.invalid/jobs/job-raw",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-raw",
        observedAt: now,
      });
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      const result = await findSignalsByJobIds(client, [job.id], { minScore: 0 });
      expect(result).toHaveLength(1);
      const row = result[0] as SignalRow;
      // Raw snake_case D1 row shape, not the camelCase SignalListItem --
      // if this had been converted, row.company_id would be undefined
      // and row.companyId would exist instead.
      expect(row.company_id).toBe(company.id);
      expect(row.role_category).toBe("cybersecurity");
      // toListItem still works on it, same as any other real SignalRow.
      expect(toListItem(row).companyId).toBe(company.id);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  // Explicit 180_000ms override, above the file's 90_000ms default -- this
  // test does more live D1 round trips (3 jobs + 2 signals + 3 evidence
  // rows) than any sibling test in this describe block, same reasoning as
  // other slow live-D1 tests in this repo (see hiringsignals memory notes
  // on reconciliation.test.ts's per-test overrides).
  it(
    "matched_job_id identifies which queried job actually backs each signal (apps/api semantic-search.ts ranking fix, 2026-08-17)",
    async () => {
    const company = await seedCompany("matched-job-id", "Matched Job Id Co");
    try {
      const source = await createSource(client, {
        companyId: company.id,
        provider: "greenhouse",
        boardToken: company.slug,
        publicUrl: `https://example.invalid/${company.slug}`,
      });
      const now = new Date().toISOString();
      const jobA = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-a",
        canonicalUrl: "https://example.invalid/jobs/job-a",
        title: "Security Engineer A",
        titleNormalized: "security engineer a",
        contentHash: "hash-job-a",
        observedAt: now,
      });
      const jobB = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-b",
        canonicalUrl: "https://example.invalid/jobs/job-b",
        title: "Security Engineer B",
        titleNormalized: "security engineer b",
        contentHash: "hash-job-b",
        observedAt: now,
      });
      // jobC is never passed to findSignalsByJobIds -- proves
      // matched_job_id is scoped to the caller's own jobIds set, not
      // just "any evidence job this signal has".
      const jobC = await upsertJob(client, {
        sourceId: source.id,
        companyId: company.id,
        externalJobId: "job-c",
        canonicalUrl: "https://example.invalid/jobs/job-c",
        title: "Security Engineer C",
        titleNormalized: "security engineer c",
        contentHash: "hash-job-c",
        observedAt: now,
      });
      // Different signal_type per signal -- createSignal enforces at most
      // one active signal per (company_id, role_category, signal_type).
      const signalForA = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        detectedAt: now,
      });
      const signalForBC = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "hiring_burst",
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId: signalForA,
        jobId: jobA.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });
      await appendSignalEvidence(client, {
        signalId: signalForBC,
        jobId: jobB.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });
      await appendSignalEvidence(client, {
        signalId: signalForBC,
        jobId: jobC.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      // Query with jobA and jobB only -- jobC deliberately excluded.
      const result = await findSignalsByJobIds(client, [jobA.id, jobB.id], { minScore: 0 });
      const byId = new Map(result.map((r) => [r.id, r]));

      // signalForA is backed only by jobA within the queried set.
      expect(byId.get(signalForA)?.matched_job_id).toBe(jobA.id);
      // signalForBC is backed by jobB within the queried set (jobC is
      // real evidence for this signal too, but wasn't in jobIds, so it
      // must never be returned as matched_job_id).
      expect(byId.get(signalForBC)?.matched_job_id).toBe(jobB.id);
      expect(byId.get(signalForBC)?.matched_job_id).not.toBe(jobC.id);
    } finally {
      await cleanupCompany(company.id);
    }
    },
    180_000,
  );
});

describe("getSignalDetail", () => {
  it("returns null for an unknown signal id", async () => {
    const result = await getSignalDetail(client, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("returns evidence with joined job fields and null lastSourceRunAt when the source has no successful run", async () => {
    const company = await seedCompany("detail-no-run", "Detail No Run Co");
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
        externalJobId: "job-detail-1",
        canonicalUrl: "https://example.invalid/jobs/job-detail-1",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-detail-1",
        observedAt: now,
      });
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      const detail = await getSignalDetail(client, signalId);
      expect(detail).not.toBeNull();
      expect(detail!.evidence).toHaveLength(1);
      const evidenceRow = detail!.evidence[0]!;
      expect(evidenceRow.jobTitle).toBe("Security Engineer");
      expect(evidenceRow.jobCanonicalUrl).toBe(
        "https://example.invalid/jobs/job-detail-1",
      );
      // No source_runs row exists at all for this source yet.
      expect(detail!.lastSourceRunAt).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns lastSourceRunAt from the most recent successful run, ignoring failed/running rows", async () => {
    const company = await seedCompany("detail-run", "Detail Run Co");
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
        externalJobId: "job-detail-2",
        canonicalUrl: "https://example.invalid/jobs/job-detail-2",
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-detail-2",
        observedAt: now,
      });
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      // Oldest successful run -- should be superseded by the newer one below.
      const oldRunId = await recordSourceRunStart(client, {
        sourceId: source.id,
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      await recordSourceRunComplete(client, oldRunId, {
        completedAt: "2026-07-01T00:05:00.000Z",
        status: "success",
      });

      // A more recent run that FAILED must not win over the older success.
      const failedRunId = await recordSourceRunStart(client, {
        sourceId: source.id,
        startedAt: "2026-07-15T00:00:00.000Z",
      });
      await recordSourceRunComplete(client, failedRunId, {
        completedAt: "2026-07-15T00:05:00.000Z",
        status: "failed_final",
      });

      // The true most-recent success -- this is the one that should win.
      const latestRunId = await recordSourceRunStart(client, {
        sourceId: source.id,
        startedAt: "2026-07-20T00:00:00.000Z",
      });
      await recordSourceRunComplete(client, latestRunId, {
        completedAt: "2026-07-20T00:05:00.000Z",
        status: "success",
      });

      const detail = await getSignalDetail(client, signalId);
      expect(detail).not.toBeNull();
      expect(detail!.lastSourceRunAt).toBe("2026-07-20T00:05:00.000Z");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns null lastSourceRunAt for a company-level signal with no representative job/source", async () => {
    const company = await seedCompany("detail-no-source", "Detail No Source Co");
    try {
      const now = new Date().toISOString();
      const signalId = await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: now,
      });
      // No source/job/evidence seeded at all -- REPRESENTATIVE_JOB_JOIN
      // finds nothing, so source_id (and therefore lastSourceRunAt)
      // must stay null rather than erroring.
      const detail = await getSignalDetail(client, signalId);
      expect(detail).not.toBeNull();
      expect(detail!.evidence).toHaveLength(0);
      expect(detail!.lastSourceRunAt).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("toListItem", () => {
  function makeRow(overrides: Partial<SignalRow> = {}): SignalRow {
    return {
      id: "sig-1",
      company_id: "c1",
      company_slug: "acme",
      company_display_name: "Acme Corp",
      role_category: "cybersecurity",
      signal_type: "new_job",
      status: "active",
      score: 72,
      score_version: "v2",
      first_detected_at: "2026-07-20T00:00:00.000Z",
      last_detected_at: "2026-07-28T00:00:00.000Z",
      expires_at: null,
      headline: "New Cybersecurity role at Acme",
      summary: "Acme posted a new Security Engineer role.",
      // Representative-job columns (2026-08-02 fix, see BASE_SELECT):
      // default null here so existing overrides-free callers of makeRow()
      // exercise the "no representative job" / company-level-signal path
      // by default; tests that care about a populated job override these.
      canonical_url: null,
      location_mode: null,
      country_code: null,
      source_platform: null,
      source_id: null,
      // Score components (migration 0010, ROADMAP V.3): null by default
      // since most test rows predate the migration.
      score_freshness: null,
      score_volume: null,
      score_acceleration: null,
      score_breadth: null,
      score_confidence: null,
      ...overrides,
    };
  }

  it("maps a valid SignalRow to a SignalListItem with camelCase fields", () => {
    const item = toListItem(makeRow());
    expect(item).toEqual({
      id: "sig-1",
      companyId: "c1",
      companySlug: "acme",
      companyDisplayName: "Acme Corp",
      roleCategory: "cybersecurity",
      signalType: "new_job",
      status: "active",
      score: 72,
      scoreVersion: "v2",
      firstDetectedAt: "2026-07-20T00:00:00.000Z",
      lastDetectedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: null,
      headline: "New Cybersecurity role at Acme",
      summary: "Acme posted a new Security Engineer role.",
      canonicalUrl: null,
      locationMode: null,
      countryCode: null,
      sourcePlatform: null,
    });
  });

  it("throws CorruptSignalRowError for an invalid signal_type", () => {
    expect(() => toListItem(makeRow({ signal_type: "not_a_real_type" }))).toThrow(
      CorruptSignalRowError,
    );
  });

  it("throws CorruptSignalRowError for an invalid status", () => {
    expect(() => toListItem(makeRow({ status: "not_a_real_status" }))).toThrow(
      CorruptSignalRowError,
    );
  });
});
