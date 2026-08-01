import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Database } from "@hiring-signals/test-support";
import {
  createD1Client,
  createCompany,
  createSignal,
  createSource,
  upsertJob,
  appendSignalEvidence,
} from "@hiring-signals/db";
import type { D1Client } from "@hiring-signals/db";
import type { Bindings } from "../../src/bindings";
import { handleReconciliation } from "../../src/jobs/reconciliation";

/**
 * Migrated off `vi.mock("@hiring-signals/db")` (AGENTS.md's "zero mocks,
 * zero fakes" policy, ROADMAP.md Milestone J) onto the real, live,
 * shared `hiring-signals` D1 database, using `createLiveD1Database()` so
 * `env.DB` is a real `D1Database`-shaped binding and `handleReconciliation`
 * runs completely unmodified -- including its own internal
 * `createD1Client(env.DB)` call -- against the live DB, same as
 * `packages/db/test/signals-write-repo.test.ts` already does for the
 * underlying repo functions this handler orchestrates.
 *
 * This file tests `handleReconciliation`'s own orchestration logic (the
 * per-signal loop, calling `computeReconciliationScore`, the evidence
 * payload shape, and the `changes === 0` skip-evidence branch) -- it
 * does NOT re-verify `listSignalsNeedingReconciliation`'s own SQL
 * filtering/ordering, which `signals-write-repo.test.ts` already covers
 * thoroughly. Each test seeds the minimum real rows needed to drive the
 * handler through one specific branch, then asserts on real read-backs
 * from `signals`/`signal_evidence`.
 *
 * Every test uses a `test-recon`-prefixed slug and cleans up in a
 * `finally` (FK-safe: signal_evidence -> signals -> companies), with an
 * `afterEach` sweep as a second pass -- same discipline as
 * signals-write-repo.test.ts.
 */

const TEST_PREFIX = "test-recon";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createD1Client(createLiveD1Database());

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

/** Same batch() atomicity reasoning as cleanupCompany above. */
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

/** Every binding this handler doesn't use throws if touched, so a wiring
 * mistake fails loudly instead of silently reading undefined. */
function unusedBinding<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`Test bug: accessed unused ${name}.${String(prop)}`);
      },
    },
  ) as T;
}

function makeEnv(db: Bindings["DB"]): Bindings {
  return {
    DB: db,
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    RAW_PAYLOADS: unusedBinding<Bindings["RAW_PAYLOADS"]>("RAW_PAYLOADS"),
    ABUSE_LOGS: unusedBinding<Bindings["ABUSE_LOGS"]>("ABUSE_LOGS"),
    ADMIN_SECRET: "unused-in-this-test",
    INGEST_QUEUE: unusedBinding<Bindings["INGEST_QUEUE"]>("INGEST_QUEUE"),
    AI: unusedBinding<Bindings["AI"]>("AI"),
    VECTORIZE: unusedBinding<Bindings["VECTORIZE"]>("VECTORIZE"),
    ENVIRONMENT: "development",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
  };
}

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

describe("handleReconciliation", () => {
  it("recomputes a stale active signal's score and appends score_recomputed evidence without moving last_detected_at", async () => {
    const company = await seedCompany("stale", "Reconciliation Stale Co");
    try {
      const staleDetectedAt = "2026-07-01T06:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 90,
        scoreVersion: "v2",
        detectedAt: staleDetectedAt,
        headline: "Stale headline",
        summary: "Stale summary.",
      });

      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));

      const persisted = await client.first<{
        score: number;
        score_version: string;
        last_detected_at: string;
      }>(`SELECT score, score_version, last_detected_at FROM signals WHERE id = ?`, [signalId]);
      expect(persisted).not.toBeNull();
      expect(persisted?.score).toBeLessThan(90);
      expect(persisted?.score_version).toBe("v2");
      // Reconciliation must never move last_detected_at -- that's the
      // staleness anchor itself.
      expect(persisted?.last_detected_at).toBe(staleDetectedAt);

      const evidenceRows = await client.all<{
        evidence_type: string;
        job_id: string | null;
        observed_at: string;
        payload_json: string;
      }>(`SELECT evidence_type, job_id, observed_at, payload_json FROM signal_evidence WHERE signal_id = ?`, [
        signalId,
      ]);
      expect(evidenceRows).toHaveLength(1);
      const evidenceRow = evidenceRows[0]!;
      expect(evidenceRow.evidence_type).toBe("score_recomputed");
      expect(evidenceRow.job_id).toBeNull();
      expect(evidenceRow.observed_at).toBe("2026-07-31T06:00:00.000Z");
      const payload = JSON.parse(evidenceRow.payload_json) as {
        reason: string;
        previousScore: number;
      };
      expect(payload.reason).toBe("daily_reconciliation_decay");
      expect(payload.previousScore).toBe(90);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("leaves a fresh (not-stale) active signal untouched", async () => {
    const company = await seedCompany("fresh", "Reconciliation Fresh Co");
    try {
      // 10 minutes before `now`, well inside the 24h staleness window.
      const freshDetectedAt = "2026-07-31T05:50:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 90,
        scoreVersion: "v2",
        detectedAt: freshDetectedAt,
        headline: "Fresh headline",
        summary: "Fresh summary.",
      });

      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));

      const persisted = await client.first<{ score: number; score_version: string }>(
        `SELECT score, score_version FROM signals WHERE id = ?`,
        [signalId],
      );
      // Untouched -- not stale enough to be selected at all.
      expect(persisted?.score).toBe(90);
      expect(persisted?.score_version).toBe("v2");

      const evidenceRows = await client.all(`SELECT id FROM signal_evidence WHERE signal_id = ?`, [
        signalId,
      ]);
      expect(evidenceRows).toHaveLength(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not append recompute evidence when the score update races with an inactive signal", async () => {
    const company = await seedCompany("raced", "Reconciliation Raced Co");
    try {
      const staleDetectedAt = "2026-07-01T06:00:00.000Z";
      const signalId = await createSignal(client, {
        companyId: company.id,
        roleCategory: "software_engineering",
        signalType: "new_job",
        score: 90,
        scoreVersion: "v2",
        detectedAt: staleDetectedAt,
        headline: "Raced headline",
        summary: "Raced summary.",
      });
      // Simulate the signal having been expired by something else between
      // listSignalsNeedingReconciliation's SELECT and updateSignalScore's
      // `AND status = 'active'` guarded UPDATE. No repo-layer "expire a
      // signal" write function exists yet, so this raw UPDATE is the only
      // way to reach this DB state -- same precedent as
      // signals-write-repo.test.ts's own status='active' guard test.
      await client.run(`UPDATE signals SET status = 'expired' WHERE id = ?`, [signalId]);

      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));

      const persisted = await client.first<{ score: number; score_version: string }>(
        `SELECT score, score_version FROM signals WHERE id = ?`,
        [signalId],
      );
      // The UPDATE's guard prevented the write -- score unchanged.
      expect(persisted?.score).toBe(90);
      expect(persisted?.score_version).toBe("v2");

      const evidenceRows = await client.all(`SELECT id FROM signal_evidence WHERE signal_id = ?`, [
        signalId,
      ]);
      expect(evidenceRows).toHaveLength(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  /**
   * still_active pass (ROADMAP.md K.1, spec section 1.4). Each test
   * seeds a company + source + job through the real repo functions,
   * then an active new_job signal with a job-linked evidence row (the
   * shape listStillActiveCandidates joins through: signal_evidence.job_id
   * -> jobs -> sources for poll_interval_minutes). `now` is fixed at
   * 2026-07-31T06:00:00.000Z, same instant used by the score-reconciliation
   * tests above, so both passes in the same handleReconciliation call can
   * be reasoned about against one clock.
   */
  async function seedStillActiveSignal(params: {
    label: string;
    signalDetectedAt: string;
    jobLastSeenAt: string;
    pollIntervalMinutes: number;
  }) {
    const company = await seedCompany(params.label, `Still Active ${params.label} Co`);
    const source = await createSource(client, {
      companyId: company.id,
      provider: "greenhouse",
      boardToken: company.slug,
      publicUrl: `https://example.invalid/${company.slug}`,
      pollIntervalMinutes: params.pollIntervalMinutes,
    });
    const job = await upsertJob(client, {
      sourceId: source.id,
      companyId: company.id,
      externalJobId: "job-1",
      canonicalUrl: `https://example.invalid/${company.slug}/jobs/job-1`,
      title: "Security Engineer",
      titleNormalized: "security engineer",
      contentHash: "hash-job-1",
      observedAt: params.jobLastSeenAt,
    });
    const signalId = await createSignal(client, {
      companyId: company.id,
      roleCategory: "cybersecurity",
      signalType: "new_job",
      score: 60,
      scoreVersion: "v2",
      detectedAt: params.signalDetectedAt,
      headline: "Still active headline",
      summary: "Still active summary.",
    });
    await appendSignalEvidence(client, {
      signalId,
      jobId: job.id,
      evidenceType: "new_job_posting",
      observedAt: params.signalDetectedAt,
      payload: { reason: "seed" },
    });
    return { company, source, job, signalId };
  }

  it("appends still_active evidence and bumps last_detected_at for a stale signal whose job was recently seen", async () => {
    const seeded = await seedStillActiveSignal({
      label: "sa-recent",
      signalDetectedAt: "2026-07-01T06:00:00.000Z",
      jobLastSeenAt: "2026-07-31T05:00:00.000Z",
      pollIntervalMinutes: 90,
    });
    try {
      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));

      const persisted = await client.first<{ last_detected_at: string; score: number }>(
        `SELECT last_detected_at, score FROM signals WHERE id = ?`,
        [seeded.signalId],
      );
      expect(persisted?.last_detected_at).toBe("2026-07-31T06:00:00.000Z");

      const evidenceRows = await client.all<{
        evidence_type: string;
        job_id: string | null;
        observed_at: string;
        payload_json: string;
      }>(
        `SELECT evidence_type, job_id, observed_at, payload_json FROM signal_evidence WHERE signal_id = ? ORDER BY observed_at ASC`,
        [seeded.signalId],
      );
      const stillActiveRow = evidenceRows.find((r) => r.evidence_type === "still_active");
      expect(stillActiveRow).toBeDefined();
      expect(stillActiveRow?.job_id).toBe(seeded.job.id);
      expect(stillActiveRow?.observed_at).toBe("2026-07-31T06:00:00.000Z");
      const payload = JSON.parse(stillActiveRow!.payload_json) as { reason: string };
      expect(payload.reason).toBe("daily_still_active_confirmation");
    } finally {
      await cleanupCompany(seeded.company.id);
    }
  });

  it("does not append still_active evidence when the backing job's last_seen_at is stale relative to its own poll interval", async () => {
    const seeded = await seedStillActiveSignal({
      label: "sa-stale-job",
      signalDetectedAt: "2026-07-01T06:00:00.000Z",
      jobLastSeenAt: "2026-07-30T00:00:00.000Z",
      pollIntervalMinutes: 90,
    });
    try {
      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));

      const evidenceRows = await client.all<{ evidence_type: string }>(
        `SELECT evidence_type FROM signal_evidence WHERE signal_id = ?`,
        [seeded.signalId],
      );
      expect(evidenceRows.some((r) => r.evidence_type === "still_active")).toBe(false);
    } finally {
      await cleanupCompany(seeded.company.id);
    }
  });

  it("does not append a second still_active evidence row the same day (idempotency guard)", async () => {
    const seeded = await seedStillActiveSignal({
      label: "sa-idempotent",
      signalDetectedAt: "2026-07-01T06:00:00.000Z",
      jobLastSeenAt: "2026-07-31T05:00:00.000Z",
      pollIntervalMinutes: 90,
    });
    try {
      const db = createLiveD1Database();
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T06:00:00.000Z"));
      await handleReconciliation(makeEnv(db), new Date("2026-07-31T14:00:00.000Z"));

      const evidenceRows = await client.all<{ evidence_type: string }>(
        `SELECT evidence_type FROM signal_evidence WHERE signal_id = ? AND evidence_type = 'still_active'`,
        [seeded.signalId],
      );
      expect(evidenceRows).toHaveLength(1);
    } finally {
      await cleanupCompany(seeded.company.id);
    }
  });
});
