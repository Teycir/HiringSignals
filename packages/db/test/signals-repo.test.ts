import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource } from "../src/sources-repo";
import { upsertJob } from "../src/jobs-repo";
import { createSignal, appendSignalEvidence } from "../src/signals-write-repo";
import {
  CorruptSignalRowError,
  InvalidCursorError,
  findSignalsByJobIds,
  listSignals,
  toListItem,
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
 * sources -> companies), with an `afterEach` sweep as a
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
 * in FK-safe order (children before parents). */
async function cleanupCompany(companyId: string): Promise<void> {
  await client.run(
    `DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id = ?)`,
    [companyId],
  );
  await client.run(`DELETE FROM signals WHERE company_id = ?`, [companyId]);
  await client.run(`DELETE FROM jobs WHERE company_id = ?`, [companyId]);
  await client.run(`DELETE FROM sources WHERE company_id = ?`, [companyId]);
  await client.run(`DELETE FROM companies WHERE id = ?`, [companyId]);
}

/** Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` (hard kill, etc.) -- matches on the
 * shared TEST_PREFIX rather than a specific id. */
afterEach(async () => {
  await client.run(
    `DELETE FROM signal_evidence WHERE signal_id IN (
       SELECT id FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
     )`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(`DELETE FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`]);
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
    const company = await seedCompany("order-newest", "Order By Newest Co");
    try {
      await seedSignal({
        companyId: company.id,
        roleCategory: "cybersecurity",
        detectedAt: "2026-07-01T00:00:00.000Z",
      });
      await seedSignal({
        companyId: company.id,
        roleCategory: "software_engineering",
        detectedAt: "2026-07-20T00:00:00.000Z",
      });
      const result = await listSignals(client, {
        company: company.slug,
        minScore: 0,
        sort: "newest",
        limit: 50,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.lastDetectedAt).toBe("2026-07-20T00:00:00.000Z");
      expect(result.items[1]?.lastDetectedAt).toBe("2026-07-01T00:00:00.000Z");
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
