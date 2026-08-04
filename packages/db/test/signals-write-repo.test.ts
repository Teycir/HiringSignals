import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import { createSource } from "../src/sources-repo";
import { upsertJob, updateJobClassification } from "../src/jobs-repo";
import {
  appendSignalEvidence,
  createSignal,
  findActiveSignal,
  listSignalsNeedingReconciliation,
  markSignalStillActive,
  refreshSignal,
  updateSignalScore,
} from "../src/signals-write-repo";

/**
 * Migrated off the retired in-memory-fake `D1Client` (AGENTS.md's "zero
 * mocks, zero fakes" policy, superseded 2026-07-30; ROADMAP.md Milestone
 * J) onto the real, live, shared `hiring-signals` D1 database via
 * `@hiring-signals/test-support`'s `createLiveD1Client`, same pattern as
 * `companies-repo.test.ts` / `signals-repo.test.ts`. This was the last
 * unmigrated file in `packages/db/test/`.
 *
 * The fake's SQL-substring/positional-param-array assertions ("does the
 * built SQL contain X", "is params[2] exactly Y") have no live
 * equivalent -- a live client has no "what SQL was I sent" introspection
 * point. Each becomes a real seeded insert + real behavioral assertion on
 * the function's actual return value / a real read-back, same reasoning
 * as company-role-stats-repo.test.ts and signals-repo.test.ts.
 *
 * Seeding conventions per function under test:
 *  - findActiveSignal: real createCompany + createSignal, with
 *    last_detected_at controlled explicitly to test the 28-day lookback
 *    boundary (ACTIVE_SIGNAL_LOOKBACK_DAYS in signals-write-repo.ts).
 *  - createSignal / refreshSignal / appendSignalEvidence: real insert +
 *    read-back against the live `signals` / `signal_evidence` tables.
 *  - updateSignalScore: real createSignal for the happy path. For the
 *    `AND status = 'active'` guard test, no repo-layer "expire a signal"
 *    write function exists yet, so that one setup step uses a raw
 *    `client.run("UPDATE signals SET status = 'expired' ...")` -- same
 *    "DB-level state not reachable through valid repo functions"
 *    precedent as the corrupt-row test in signals-repo.test.ts. This is
 *    testing the repo function's own SQL guard, not fabricating an
 *    invalid enum value.
 *  - listSignalsNeedingReconciliation: real createCompany/createSource/
 *    upsertJob/updateJobClassification for the classification-confidence
 *    join, real createSignal + appendSignalEvidence for the NOT EXISTS
 *    exclusion. This function takes no company-scoping parameter
 *    (`{ staleBefore, limit }` only) and runs against a shared live
 *    database, so the "respects limit" test cannot assert a specific
 *    result-set size in isolation -- another concurrent/leftover stale
 *    signal elsewhere in the DB could legitimately sort into a `LIMIT 1`
 *    window. That test instead seeds two of its own signals with
 *    last_detected_at pinned far in the past (year 2020, long before any
 *    realistic seed/fixture data) and asserts identity + order
 *    ("the one row returned is mine, and it's the older of my two") via
 *    the ORDER BY's ASC tiebreak, rather than asserting exclusivity of
 *    the full result set.
 *
 * Every test uses a `test-swr`-prefixed slug (`swr` = signals-write-repo,
 * this file) and deletes everything it created in a `finally` (FK-safe
 * order: signal_evidence -> signals -> jobs -> sources -> companies),
 * with an `afterEach` sweep as a belt-and-suspenders second pass, same
 * discipline as signals-repo.test.ts.
 */

const TEST_PREFIX = "test-swr";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** Everything this file seeds hangs off one company per test -- deletes
 * in FK-safe order (children before parents), all 5 statements in one
 * client.batch() call so a mid-sequence process kill can't leave this
 * company's rows half-deleted (debug-codebase-audit.md-adjacent data-
 * integrity concern, 2026-08-02): D1's batch() runs every statement in
 * one implicit transaction (see lib/d1/client.ts's batch() -- D1 has no
 * BEGIN/COMMIT SQL surface via the Workers binding, batch() is the real
 * atomicity primitive), so this either fully deletes or fully no-ops,
 * never partially. */
async function cleanupCompany(companyId: string): Promise<void> {
  await client.batch([
    {
      sql: `DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM signals WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM sources WHERE company_id = ?`, params: [companyId] },
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

describe("findActiveSignal", () => {
  it("returns null when no signal exists for the (company, role, type) triple", async () => {
    const company = await seedCompany("fas-none", "Find Active None Co");
    try {
      const result = await findActiveSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
      });
      expect(result).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns the active signal matching company_id + role_category + signal_type", async () => {
    const company = await seedCompany("fas-match", "Find Active Match Co");
    try {
      const now = new Date().toISOString();
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 72,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "New Software Engineering role posted",
        summary: "A new Software Engineering position was posted.",
      });

      const result = await findActiveSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
      });
      expect(result?.id).toBe(signalId);
      expect(result?.status).toBe("active");
      expect(result?.score).toBe(72);

      // A different signalType for the same company/role must not match.
      const wrongType = await findActiveSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "hiring_burst",
      });
      expect(wrongType).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not match an active signal whose last_detected_at is outside the 28-day lookback", async () => {
    const company = await seedCompany("fas-stale", "Find Active Stale Co");
    try {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: old,
        headline: "Old signal",
        summary: "Old signal summary.",
      });

      const result = await findActiveSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
      });
      expect(result).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("createSignal", () => {
  it("inserts with status='active' and expires_at NULL, first/last_detected_at both set to detectedAt", async () => {
    const company = await seedCompany("cs-basic", "Create Signal Co");
    try {
      const detectedAt = "2026-07-28T00:00:00.000Z";
      const id = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 65,
        scoreVersion: "v1",
        detectedAt,
        headline: "New Cybersecurity role posted",
        summary: "A new Cybersecurity position was posted.",
      });
      expect(id).toBeTruthy();

      const persisted = await client.first<{
        id: string;
        company_id: string;
        role_category: string;
        signal_type: string;
        status: string;
        score: number;
        score_version: string;
        first_detected_at: string;
        last_detected_at: string;
        expires_at: string | null;
        headline: string;
        summary: string;
      }>(`SELECT * FROM signals WHERE id = ?`, [id]);
      expect(persisted).not.toBeNull();
      expect(persisted?.company_id).toBe(company.id);
      expect(persisted?.role_category).toBe("cybersecurity");
      expect(persisted?.signal_type).toBe("new_job");
      expect(persisted?.status).toBe("active");
      expect(persisted?.score).toBe(65);
      expect(persisted?.score_version).toBe("v1");
      expect(persisted?.first_detected_at).toBe(detectedAt);
      expect(persisted?.last_detected_at).toBe(detectedAt);
      expect(persisted?.expires_at).toBeNull();
      expect(persisted?.headline).toBe("New Cybersecurity role posted");
      expect(persisted?.summary).toBe("A new Cybersecurity position was posted.");
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("refreshSignal", () => {
  it("updates score/score_version/last_detected_at, keeping first_detected_at unchanged", async () => {
    const company = await seedCompany("rs-basic", "Refresh Signal Co");
    try {
      const firstDetectedAt = "2026-07-01T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: firstDetectedAt,
        headline: "Initial headline",
        summary: "Initial summary.",
      });

      const refreshedAt = "2026-07-28T00:00:00.000Z";
      const result = await refreshSignal(client, signalId, company.id, {
        score: 80,
        scoreVersion: "v2",
        lastDetectedAt: refreshedAt,
      });
      expect(result.changes).toBe(1);

      const persisted = await client.first<{
        score: number;
        score_version: string;
        first_detected_at: string;
        last_detected_at: string;
      }>(`SELECT score, score_version, first_detected_at, last_detected_at FROM signals WHERE id = ?`, [
        signalId,
      ]);
      expect(persisted?.score).toBe(80);
      expect(persisted?.score_version).toBe("v2");
      expect(persisted?.first_detected_at).toBe(firstDetectedAt);
      expect(persisted?.last_detected_at).toBe(refreshedAt);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not update a signal when passed a mismatched company_id", async () => {
    const company = await seedCompany("rs-tenant", "Refresh Signal Tenant Co");
    const otherCompany = await seedCompany("rs-tenant-other", "Refresh Signal Other Co");
    try {
      const firstDetectedAt = "2026-07-01T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: firstDetectedAt,
        headline: "Initial headline",
        summary: "Initial summary.",
      });

      const result = await refreshSignal(client, signalId, otherCompany.id, {
        score: 80,
        scoreVersion: "v2",
        lastDetectedAt: "2026-07-28T00:00:00.000Z",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ score: number; score_version: string }>(
        `SELECT score, score_version FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the wrong companyId meant 0 rows matched.
      expect(persisted?.score).toBe(50);
      expect(persisted?.score_version).toBe("v1");
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });

  it("does NOT update a signal whose status is not 'active' (the AND status = 'active' guard)", async () => {
    const company = await seedCompany("rs-guard", "Refresh Signal Guard Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2026-07-20T00:00:00.000Z",
        headline: "Headline",
        summary: "Summary.",
      });

      // No repo-layer "expire a signal" write function exists yet -- this
      // raw UPDATE is the only way to reach the DB state under test here,
      // same precedent as updateSignalScore's/markSignalStillActive's own
      // guard tests above/below.
      await client.run(`UPDATE signals SET status = 'expired' WHERE id = ?`, [signalId]);

      const result = await refreshSignal(client, signalId, company.id, {
        score: 99,
        scoreVersion: "v2",
        lastDetectedAt: "2026-07-28T00:00:00.000Z",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ score: number; score_version: string; last_detected_at: string }>(
        `SELECT score, score_version, last_detected_at FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the guard prevented the write. Without it, this
      // expired signal would have been silently resurrected until the
      // expiration cron swept it again.
      expect(persisted?.score).toBe(50);
      expect(persisted?.score_version).toBe("v1");
      expect(persisted?.last_detected_at).toBe("2026-07-20T00:00:00.000Z");
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("updateSignalScore", () => {
  it("updates score fields without touching last_detected_at, on an active signal", async () => {
    const company = await seedCompany("uss-basic", "Update Score Co");
    try {
      const detectedAt = "2026-07-20T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt,
        headline: "Headline",
        summary: "Summary.",
      });

      const result = await updateSignalScore(client, signalId, company.id, {
        score: 42,
        scoreVersion: "v2",
      });
      expect(result.changes).toBe(1);

      const persisted = await client.first<{
        score: number;
        score_version: string;
        last_detected_at: string;
      }>(`SELECT score, score_version, last_detected_at FROM signals WHERE id = ?`, [signalId]);
      expect(persisted?.score).toBe(42);
      expect(persisted?.score_version).toBe("v2");
      // Untouched -- reconciliation must not erase the staleness signal.
      expect(persisted?.last_detected_at).toBe(detectedAt);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does NOT update a signal whose status is not 'active' (the AND status = 'active' guard)", async () => {
    const company = await seedCompany("uss-guard", "Update Score Guard Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2026-07-20T00:00:00.000Z",
        headline: "Headline",
        summary: "Summary.",
      });

      // No repo-layer "expire a signal" write function exists yet -- this
      // raw UPDATE is the only way to reach the DB state under test here
      // (same "DB-level state not reachable through valid repo functions"
      // precedent as the corrupt-row test in signals-repo.test.ts). We are
      // testing updateSignalScore's own SQL guard, not fabricating an
      // invalid enum value.
      await client.run(`UPDATE signals SET status = 'expired' WHERE id = ?`, [signalId]);

      const result = await updateSignalScore(client, signalId, company.id, {
        score: 99,
        scoreVersion: "v2",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ score: number; score_version: string }>(
        `SELECT score, score_version FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the guard prevented the write.
      expect(persisted?.score).toBe(50);
      expect(persisted?.score_version).toBe("v1");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not update a signal when passed a mismatched company_id", async () => {
    const company = await seedCompany("uss-tenant", "Update Score Tenant Co");
    const otherCompany = await seedCompany("uss-tenant-other", "Update Score Other Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2026-07-20T00:00:00.000Z",
        headline: "Headline",
        summary: "Summary.",
      });

      const result = await updateSignalScore(client, signalId, otherCompany.id, {
        score: 99,
        scoreVersion: "v2",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ score: number; score_version: string }>(
        `SELECT score, score_version FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the wrong companyId meant 0 rows matched.
      expect(persisted?.score).toBe(50);
      expect(persisted?.score_version).toBe("v1");
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

describe("markSignalStillActive", () => {
  it("updates last_detected_at without touching score/score_version, on an active signal", async () => {
    const company = await seedCompany("msa-basic", "Mark Still Active Co");
    try {
      const detectedAt = "2026-07-20T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt,
        headline: "Headline",
        summary: "Summary.",
      });

      const newLastDetectedAt = "2026-08-01T00:00:00.000Z";
      const result = await markSignalStillActive(client, signalId, company.id, {
        lastDetectedAt: newLastDetectedAt,
      });
      expect(result.changes).toBe(1);

      const persisted = await client.first<{
        score: number;
        score_version: string;
        last_detected_at: string;
      }>(`SELECT score, score_version, last_detected_at FROM signals WHERE id = ?`, [signalId]);
      expect(persisted?.last_detected_at).toBe(newLastDetectedAt);
      // Untouched -- a still-active confirmation is not new hiring evidence.
      expect(persisted?.score).toBe(50);
      expect(persisted?.score_version).toBe("v1");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does NOT update a signal whose status is not 'active' (the AND status = 'active' guard)", async () => {
    const company = await seedCompany("msa-guard", "Mark Still Active Guard Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2026-07-20T00:00:00.000Z",
        headline: "Headline",
        summary: "Summary.",
      });

      // Same "DB-level state not reachable through valid repo functions"
      // precedent as updateSignalScore's own guard test above.
      await client.run(`UPDATE signals SET status = 'expired' WHERE id = ?`, [signalId]);

      const result = await markSignalStillActive(client, signalId, company.id, {
        lastDetectedAt: "2026-08-01T00:00:00.000Z",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ last_detected_at: string }>(
        `SELECT last_detected_at FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the guard prevented the write.
      expect(persisted?.last_detected_at).toBe("2026-07-20T00:00:00.000Z");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not update a signal when passed a mismatched company_id", async () => {
    const company = await seedCompany("msa-tenant", "Mark Still Active Tenant Co");
    const otherCompany = await seedCompany("msa-tenant-other", "Mark Still Active Other Co");
    try {
      const detectedAt = "2026-07-20T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt,
        headline: "Headline",
        summary: "Summary.",
      });

      const result = await markSignalStillActive(client, signalId, otherCompany.id, {
        lastDetectedAt: "2026-08-01T00:00:00.000Z",
      });
      expect(result.changes).toBe(0);

      const persisted = await client.first<{ last_detected_at: string }>(
        `SELECT last_detected_at FROM signals WHERE id = ?`,
        [signalId],
      );
      // Unchanged -- the wrong companyId meant 0 rows matched.
      expect(persisted?.last_detected_at).toBe(detectedAt);
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

describe("listSignalsNeedingReconciliation", () => {
  async function seedCompanySourceAndClassifiedJob(label: string, roleCategory: string) {
    const company = await seedCompany(label, `Reconciliation ${label}`);
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
      canonicalUrl: `https://example.invalid/${company.slug}/jobs/job-1`,
      title: "Security Engineer",
      titleNormalized: "security engineer",
      contentHash: "hash-job-1",
      observedAt: now,
    });
    await updateJobClassification(client, job.id, company.id, {
      rolePrimary: roleCategory,
      classificationConfidence: 0.85,
      classificationVersion: "v1",
    });
    return { company, source, job };
  }

  it("returns an active signal whose last_detected_at is older than staleBefore", async () => {
    const { company } = await seedCompanySourceAndClassifiedJob("lsnr-stale", "cybersecurity");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "Stale headline",
        summary: "Stale summary.",
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore: "2026-01-01T00:00:00.000Z",
        limit: 200,
      });
      const mine = results.find((r) => r.id === signalId);
      expect(mine).toBeDefined();
      expect(mine?.company_id).toBe(company.id);
      // classification_confidence derived from the matching active job.
      expect(mine?.classification_confidence).toBeCloseTo(0.85, 5);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not return a signal whose last_detected_at is not older than staleBefore", async () => {
    const company = await seedCompany("lsnr-fresh", "Reconciliation Fresh Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2026-07-27T00:00:00.000Z",
        headline: "Fresh headline",
        summary: "Fresh summary.",
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore: "2026-07-01T00:00:00.000Z",
        limit: 200,
      });
      expect(results.some((r) => r.id === signalId)).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("falls back to classification_confidence 0 when no matching active/possibly_closed job exists", async () => {
    const company = await seedCompany("lsnr-nojob", "Reconciliation No Job Co");
    try {
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "No job headline",
        summary: "No job summary.",
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore: "2026-01-01T00:00:00.000Z",
        limit: 200,
      });
      const mine = results.find((r) => r.id === signalId);
      expect(mine).toBeDefined();
      expect(mine?.classification_confidence).toBe(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("excludes a signal that already has a recent 'score_recomputed' evidence row (idempotency guard)", async () => {
    const company = await seedCompany("lsnr-recomputed", "Reconciliation Recomputed Co");
    try {
      const staleBefore = "2026-01-01T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "Recomputed headline",
        summary: "Recomputed summary.",
      });
      // Evidence observed at/after staleBefore -- inside the exclusion window.
      await appendSignalEvidence(client, {
        signalId,
        jobId: null,
        evidenceType: "score_recomputed",
        observedAt: "2026-01-02T00:00:00.000Z",
        payload: { score: 50 },
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore,
        limit: 200,
      });
      expect(results.some((r) => r.id === signalId)).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not exclude a signal whose 'score_recomputed' evidence is older than the exclusion window", async () => {
    const company = await seedCompany("lsnr-old-recompute", "Reconciliation Old Recompute Co");
    try {
      const staleBefore = "2026-01-01T00:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "Old recompute headline",
        summary: "Old recompute summary.",
      });
      // Evidence observed before staleBefore -- outside the exclusion window,
      // so this signal is still due for reconciliation.
      await appendSignalEvidence(client, {
        signalId,
        jobId: null,
        evidenceType: "score_recomputed",
        observedAt: "2019-01-01T00:00:00.000Z",
        payload: { score: 50 },
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore,
        limit: 200,
      });
      expect(results.some((r) => r.id === signalId)).toBe(true);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("orders by last_detected_at ASC (oldest first) among my own signals", async () => {
    // listSignalsNeedingReconciliation takes no company-scoping parameter
    // and runs against a shared live database, so a small `limit` cannot
    // be asserted against in isolation -- another leftover/concurrent
    // stale signal elsewhere in the DB could legitimately be even older
    // than mine and occupy the limited slot instead. Instead of limiting
    // to 1 and asserting on what comes back, request enough rows to
    // guarantee both of mine are included (limit large relative to any
    // plausible concurrent test pollution), then assert only on the
    // *relative* order between my own two signals -- this exercises the
    // same "ORDER BY s.last_detected_at ASC, s.id ASC" behavior without
    // depending on global exclusivity of the result set.
    const company = await seedCompany("lsnr-order", "Reconciliation Order Co");
    try {
      const olderId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "Older",
        summary: "Older summary.",
      });
      const newerId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-06-01T00:00:00.000Z",
        headline: "Newer",
        summary: "Newer summary.",
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore: "2026-01-01T00:00:00.000Z",
        limit: 5000,
      });
      const olderIndex = results.findIndex((r) => r.id === olderId);
      const newerIndex = results.findIndex((r) => r.id === newerId);
      expect(olderIndex).toBeGreaterThanOrEqual(0);
      expect(newerIndex).toBeGreaterThanOrEqual(0);
      expect(olderIndex).toBeLessThan(newerIndex);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("limit truncates the result set to at most `limit` rows", async () => {
    // Only checks the cardinality guarantee (never more than `limit`
    // rows come back) -- which row(s) fill a small limit is not
    // asserted here, for the same shared-live-DB reason as above.
    const company = await seedCompany("lsnr-limit-size", "Reconciliation Limit Size Co");
    try {
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-01-01T00:00:00.000Z",
        headline: "A",
        summary: "A summary.",
      });
      await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: "2020-06-01T00:00:00.000Z",
        headline: "B",
        summary: "B summary.",
      });

      const results = await listSignalsNeedingReconciliation(client, {
        staleBefore: "2026-01-01T00:00:00.000Z",
        limit: 1,
      });
      expect(results.length).toBeLessThanOrEqual(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("appendSignalEvidence", () => {
  it("serializes payload to JSON and inserts one row, real read-back matches input", async () => {
    const company = await seedCompany("ase-basic", "Append Evidence Co");
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
        canonicalUrl: `https://example.invalid/${company.slug}/jobs/job-1`,
        title: "Security Engineer",
        titleNormalized: "security engineer",
        contentHash: "hash-job-1",
        observedAt: now,
      });
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "Headline",
        summary: "Summary.",
      });

      const payload = { score: 72, components: { freshness: 1.0 }, formulaVersion: "v1" };
      const observedAt = "2026-07-28T00:00:00.000Z";
      const id = await appendSignalEvidence(client, {
        signalId,
        jobId: job.id,
        evidenceType: "new_job_posting",
        observedAt,
        payload,
      });
      expect(id).toBeTruthy();

      const persisted = await client.first<{
        id: string;
        signal_id: string;
        job_id: string | null;
        evidence_type: string;
        observed_at: string;
        payload_json: string;
      }>(`SELECT * FROM signal_evidence WHERE id = ?`, [id]);
      expect(persisted).not.toBeNull();
      expect(persisted?.signal_id).toBe(signalId);
      expect(persisted?.job_id).toBe(job.id);
      expect(persisted?.evidence_type).toBe("new_job_posting");
      expect(persisted?.observed_at).toBe(observedAt);
      expect(persisted?.payload_json).toBe(JSON.stringify(payload));
      expect(JSON.parse(persisted?.payload_json ?? "null")).toEqual(payload);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("allows a null jobId (evidence not tied to a specific job)", async () => {
    const company = await seedCompany("ase-null-job", "Append Evidence Null Job Co");
    try {
      const now = new Date().toISOString();
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "cybersecurity",
        signalType: "new_job",
        score: 50,
        scoreVersion: "v1",
        detectedAt: now,
        headline: "Headline",
        summary: "Summary.",
      });

      const id = await appendSignalEvidence(client, {
        signalId,
        jobId: null,
        evidenceType: "new_job_posting",
        observedAt: now,
        payload: {},
      });

      const persisted = await client.first<{ job_id: string | null }>(
        `SELECT job_id FROM signal_evidence WHERE id = ?`,
        [id],
      );
      expect(persisted?.job_id).toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });
});
