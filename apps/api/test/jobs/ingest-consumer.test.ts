import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { Message, VectorizeVector } from "@cloudflare/workers-types";
import type { IngestMessage } from "@hiring-signals/domain";
import {
  createLiveD1Database,
  createLiveAiBinding,
  createLiveVectorizeIndex,
  createLiveKvNamespace,
} from "@hiring-signals/test-support";
import { createD1Client, createCompany, createSource } from "@hiring-signals/db";
import type { D1Client } from "@hiring-signals/db";
import type { Bindings } from "../../src/bindings";

/**
 * Migrated off `vi.mock("@hiring-signals/db")` + the hand-built in-memory
 * fake D1 client (AGENTS.md's "zero mocks, zero fakes" policy,
 * ROADMAP.md Milestone J) onto the real, live, shared `hiring-signals`
 * D1 database, Workers AI binding, and Vectorize index, via
 * `@hiring-signals/test-support`. `handleIngestMessage` now runs
 * completely unmodified -- including its own internal
 * `createD1Client(env.DB)` call -- against live infrastructure, same
 * migration pattern as `reconciliation.test.ts`/`scheduler.test.ts` in
 * this directory.
 *
 * Two documented, permanent exceptions stay mocked/faked (AGENTS.md's
 * "zero mocks" section, 2026-07-30 decision -- NOT a gap in this
 * migration, these are explicitly out of scope for it):
 *  - `@hiring-signals/adapters` (`vi.mock`): `getAdapterForProvider` is
 *    replaced so `fetchBoard`/`normalize` return scripted values (a
 *    canned job payload, or a scripted HTTP status like 429/503/404).
 *    There is no Cloudflare account resource backing a real ATS board
 *    fetch, and no way to make a real board return 429/503/404 on
 *    demand -- see AGENTS.md for the full reasoning.
 *  - `INGEST_QUEUE` (`Bindings["INGEST_QUEUE"]`): stays an in-memory
 *    `sent: []` capture array, never the real Cloudflare Queue -- a real
 *    `send()` would actually deliver to the same queue the deployed
 *    consumer is subscribed to, re-triggering `handleIngestMessage` from
 *    inside a test of `handleIngestMessage`.
 *
 * Everything else this handler touches -- `DB`, `AI`, `VECTORIZE`,
 * `RAW_PAYLOADS` -- is now a real live binding
 * (`createLiveD1Database()`/`createLiveAiBinding()`/
 * `createLiveVectorizeIndex()`/`createLiveKvNamespace("RAW_PAYLOADS")`).
 * `CACHE`/`ABUSE_LOGS`/`ADMIN_SECRET` stay `unusedBinding()` placeholders
 * -- confirmed genuinely unused by this handler (facets KV cache
 * invalidation is deliberately not part of this pipeline, per
 * ROADMAP.md Milestone D's own note).
 */

/**
 * Seeding conventions, matching `signals-write-repo.test.ts`'s
 * established style: every test seeds its own `test-ic`-prefixed company
 * + source via real `createCompany`/`createSource` calls, then drives
 * the pipeline through `handleIngestMessage` itself (not direct repo
 * calls) so jobs/observations/signals/evidence are whatever the real
 * pipeline actually wrote -- assertions read those back with plain
 * `SELECT`s via the same live `D1Client` the seeding helpers use.
 *
 * Cleanup order (FK-safe, children before parents): signal_evidence ->
 * signals -> job_observations -> jobs -> source_runs -> sources ->
 * companies (migration 0001: job_observations references both jobs(id)
 * and source_runs(id), so it must be deleted before either of those two,
 * and signal_evidence references signals(id) and optionally jobs(id), so
 * it goes first of all). Every test cleans up in a `finally`, with an
 * `afterEach` sweep as a second pass -- same discipline as every other
 * migrated file in this directory. Any Vectorize vector written for a
 * cleaned-up job id is also deleted (best-effort) -- the fake this file
 * used to have never had a real vector to clean up before.
 *
 * Wall-clock cost: each live D1 call shells out to a fresh `wrangler d1
 * execute --remote` process (~3.7s of cold-start overhead per call, see
 * `apps/api/vitest.config.ts`'s header comment), and `handleIngestMessage`
 * makes many D1 calls per job (upsert, observation, lifecycle read/write,
 * classification write, activity-stats read, signal find/create/refresh,
 * evidence insert) plus one real Workers AI embed + Vectorize upsert per
 * new/changed job. Tests with multiple jobs or multiple sequential
 * `handleIngestMessage` calls are correspondingly slower than
 * `reconciliation.test.ts`/`scheduler.test.ts` -- this file's own
 * `vitest.config.ts` timeout (90s) applies per test, not per file.
 */

const TEST_PREFIX = "test-ic";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createD1Client(createLiveD1Database());

/** Best-effort delete of a job's Vectorize vector -- a missing vector
 * (embedding failed mid-test, or was never written) must not fail the
 * test's own cleanup step, same spirit as the app code's own
 * embed-is-best-effort policy. */
async function cleanupVector(jobId: string): Promise<void> {
  try {
    await createLiveVectorizeIndex().deleteByIds([jobId]);
  } catch {
    // best-effort -- see header comment
  }
}

async function cleanupCompany(companyId: string): Promise<void> {
  const jobRows = await client
    .all<{ id: string }>(`SELECT id FROM jobs WHERE company_id = ?`, [companyId])
    .catch(() => [] as { id: string }[]);
  await client.run(
    `DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id = ?)`,
    [companyId],
  );
  await client.run(`DELETE FROM signals WHERE company_id = ?`, [companyId]);
  await client.run(
    `DELETE FROM job_observations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = ?)`,
    [companyId],
  );
  await client.run(`DELETE FROM jobs WHERE company_id = ?`, [companyId]);
  await client.run(
    `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id = ?)`,
    [companyId],
  );
  await client.run(`DELETE FROM sources WHERE company_id = ?`, [companyId]);
  await client.run(`DELETE FROM companies WHERE id = ?`, [companyId]);
  await Promise.all(jobRows.map((j) => cleanupVector(j.id)));
}

/** Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` -- matches on the shared TEST_PREFIX. */
afterEach(async () => {
  const companyRows = await client
    .all<{ id: string }>(`SELECT id FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`])
    .catch(() => [] as { id: string }[]);
  const jobRowsByCompany = await Promise.all(
    companyRows.map((c) =>
      client.all<{ id: string }>(`SELECT id FROM jobs WHERE company_id = ?`, [c.id]).catch(() => [] as { id: string }[]),
    ),
  );

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
    `DELETE FROM job_observations WHERE job_id IN (
       SELECT id FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
     )`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM source_runs WHERE source_id IN (
       SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
     )`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(
    `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(`DELETE FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`]);

  const allJobIds = jobRowsByCompany.flat().map((j) => j.id);
  await Promise.all(allJobIds.map((id) => cleanupVector(id)));
});

/** Every binding this handler doesn't use throws if touched, so a wiring
 * mistake fails loudly instead of silently reading undefined -- same
 * pattern as reconciliation.test.ts/scheduler.test.ts. */
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

/**
 * Fake adapter (mirrors AtsAdapter): normalize() returns one job whose
 * title, "Site Reliability Engineer", title-matches PHRASE_RULES so
 * classifyJob() resolves role_primary="cloud_platform_devops_sre" at
 * confidence 0.70 from title alone. departmentRaw is also set to the
 * same matching phrase so confidence reaches 0.90 (title 0.70 +
 * department 0.20) and clears AUTO_CLASSIFY_THRESHOLD (0.80) -- this
 * specific combination only became reachable after the 2026-07-28 fix to
 * classifyJob (see packages/domain/src/classification.ts); before that
 * fix, a title match short-circuited before department was even
 * inspected, capping confidence at 0.70 and making signal generation
 * (gated on autoClassified) unreachable in this pipeline. This test
 * exists specifically to prove the consumer's signal-generation branch
 * is not dead code.
 *
 * Adapter mocking is the documented AGENTS.md exception (see file header)
 * -- not a leftover from the pre-migration fake.
 */
let fetchBoardImpl: ReturnType<typeof vi.fn>;
let normalizeImpl: ReturnType<typeof vi.fn>;

vi.mock("@hiring-signals/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hiring-signals/adapters")>();
  return {
    ...actual,
    getAdapterForProvider: (provider: string) => {
      if (provider !== "greenhouse") throw new actual.UnsupportedProviderError(provider as never);
      return {
        provider: "greenhouse",
        fetchBoard: (...args: unknown[]) => fetchBoardImpl(...args),
        normalize: (...args: unknown[]) => normalizeImpl(...args),
      };
    },
  };
});

const { handleIngestMessage } = await import("../../src/jobs/ingest-consumer");

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

async function seedSource(companyId: string, boardToken: string, provider: "greenhouse" | "lever" = "greenhouse") {
  return createSource(client, {
    companyId,
    provider,
    boardToken,
    publicUrl: `https://example.invalid/${boardToken}`,
  });
}

function makeNormalizedJob(externalJobId = "job-ext-1") {
  return {
    externalJobId,
    canonicalUrl: `https://example.com/jobs/${externalJobId}`,
    title: "Site Reliability Engineer",
    department: "Site Reliability Engineer",
    descriptionText: "Join our infra team.",
    locationRaw: "Remote - US",
    locationMode: "remote" as const,
  };
}

/**
 * Records of calls into the real AI/VECTORIZE bindings this test run
 * actually made -- wrapping createLiveAiBinding()/createLiveVectorizeIndex()
 * rather than replacing them, so the underlying call still goes out for
 * real, but the test can still assert "was AI.run called, with what
 * inputs" the same way the pre-migration fake did. Module-level, reset
 * per test via makeLiveEnv() -- same pattern the old aiRunCalls/
 * vectorizeUpsertCalls module-level arrays used.
 */
let aiRunCalls: Array<{ model: string; inputs: unknown }> = [];
let vectorizeUpsertCalls: Array<VectorizeVector[]> = [];
/** Overridable per-test: when set, replaces the real AI.run call with a
 * rejection, for the log-and-continue failure-path test -- the real
 * Workers AI binding has no way to force a failure on demand, so that
 * one test still needs a scripted rejection here (the adapter-mocking
 * exception's own reasoning applies equally to "force a provider
 * outage" for a binding with no test-double surface). */
let aiRunOverride: (() => Promise<unknown>) | null = null;

function makeLiveEnv(db: Bindings["DB"]): { env: Bindings; sent: Array<{ message: IngestMessage; delaySeconds?: number }> } {
  const sent: Array<{ message: IngestMessage; delaySeconds?: number }> = [];
  aiRunCalls = [];
  vectorizeUpsertCalls = [];
  const realAi = createLiveAiBinding();
  const realVectorize = createLiveVectorizeIndex();
  const env: Bindings = {
    DB: db,
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    RAW_PAYLOADS: createLiveKvNamespace("RAW_PAYLOADS"),
    ABUSE_LOGS: unusedBinding<Bindings["ABUSE_LOGS"]>("ABUSE_LOGS"),
    ADMIN_SECRET: "unused-in-this-test",
    INGEST_QUEUE: {
      send: async (message: IngestMessage, options?: { delaySeconds?: number }) => {
        sent.push({ message, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Bindings["INGEST_QUEUE"],
    AI: {
      run: async (model: string, inputs: unknown) => {
        aiRunCalls.push({ model, inputs });
        if (aiRunOverride) return aiRunOverride();
        return (realAi as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, inputs);
      },
    } as unknown as Bindings["AI"],
    VECTORIZE: {
      upsert: async (vectors: VectorizeVector[]) => {
        vectorizeUpsertCalls.push(vectors);
        return realVectorize.upsert(vectors);
      },
    } as unknown as Bindings["VECTORIZE"],
    ENVIRONMENT: "development",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
  };
  return { env, sent };
}

function makeMessage(body: IngestMessage): { message: Message<IngestMessage>; acked: boolean[]; retried: boolean[] } {
  const acked: boolean[] = [];
  const retried: boolean[] = [];
  const message = {
    body,
    ack: () => acked.push(true),
    retry: () => retried.push(true),
  } as unknown as Message<IngestMessage>;
  return { message, acked, retried };
}

beforeEach(() => {
  fetchBoardImpl = vi.fn(async () => ({ httpStatus: 200, rawBody: { jobs: [] } }));
  normalizeImpl = vi.fn(() => [makeNormalizedJob()]);
  aiRunOverride = null;
});

/** Read-back helpers -- real SELECTs against the live DB, replacing the
 * old fake's in-memory Maps. */
async function getJobsForCompany(companyId: string) {
  return client.all<{
    id: string;
    external_job_id: string;
    status: string;
    role_primary: string | null;
    classification_confidence: number | null;
    missing_run_count: number;
  }>(
    `SELECT id, external_job_id, status, role_primary, classification_confidence, missing_run_count
     FROM jobs WHERE company_id = ?`,
    [companyId],
  );
}

async function getObservationCount(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const placeholders = jobIds.map(() => "?").join(",");
  const row = await client.first<{ n: number }>(
    `SELECT COUNT(*) as n FROM job_observations WHERE job_id IN (${placeholders})`,
    jobIds,
  );
  return row?.n ?? 0;
}

async function getSignalsForCompany(companyId: string) {
  return client.all<{
    id: string;
    company_id: string;
    role_category: string;
    signal_type: string;
    first_detected_at: string;
    last_detected_at: string;
  }>(
    `SELECT id, company_id, role_category, signal_type, first_detected_at, last_detected_at
     FROM signals WHERE company_id = ?`,
    [companyId],
  );
}

async function getEvidenceForSignals(signalIds: string[]) {
  if (signalIds.length === 0) return [];
  const placeholders = signalIds.map(() => "?").join(",");
  return client.all<{ id: string; signal_id: string; job_id: string | null; evidence_type: string }>(
    `SELECT id, signal_id, job_id, evidence_type FROM signal_evidence WHERE signal_id IN (${placeholders}) ORDER BY id ASC`,
    signalIds,
  );
}

async function getSourceRun(runId: string) {
  return client.first<{ id: string; status: string; error_code: string | null }>(
    `SELECT id, status, error_code FROM source_runs WHERE id = ?`,
    [runId],
  );
}

describe("handleIngestMessage - happy path", () => {
  it("runs the full pipeline: upsert, observation, lifecycle, classification, signal creation", async () => {
    const company = await seedCompany("happy", "Happy Path Co");
    try {
      const source = await seedSource(company.id, testSlug("happy-src"));
      const runId = testSlug("happy-run");
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);

      const jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.status).toBe("active");
      expect(job.role_primary).toBe("cloud_platform_devops_sre");
      expect(job.classification_confidence).toBeCloseTo(0.9, 5);

      expect(await getObservationCount([job.id])).toBe(1);

      const signals = await getSignalsForCompany(company.id);
      expect(signals).toHaveLength(1);
      const signal = signals[0]!;
      expect(signal.company_id).toBe(company.id);
      expect(signal.role_category).toBe("cloud_platform_devops_sre");
      expect(signal.signal_type).toBe("new_job");
      expect(await getEvidenceForSignals([signal.id])).toHaveLength(1);

      const run = await getSourceRun(runId);
      expect(run?.status).toBe("success");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("I.2: embeds a new job and upserts the vector with the documented metadata shape (spec §9.4)", async () => {
    const company = await seedCompany("embed", "Embed Path Co");
    try {
      const source = await seedSource(company.id, testSlug("embed-src"));
      const runId = testSlug("embed-run");
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);

      expect(aiRunCalls).toHaveLength(1);
      expect(aiRunCalls[0]!.model).toBe("@cf/baai/bge-base-en-v1.5");
      expect(aiRunCalls[0]!.inputs).toEqual({
        text: ["Site Reliability Engineer\nSite Reliability Engineer\nRemote - US\nJoin our infra team."],
      });

      expect(vectorizeUpsertCalls).toHaveLength(1);
      const [vector] = vectorizeUpsertCalls[0]!;
      const jobs = await getJobsForCompany(company.id);
      const job = jobs[0]!;
      expect(vector!.id).toBe(job.id);
      expect(vector!.values).toHaveLength(768);
      expect(vector!.metadata).toMatchObject({
        companyId: company.id,
        status: "active",
        locationMode: "remote",
      });
      expect(vector!.metadata).not.toHaveProperty("roleCategory");
      expect(typeof vector!.metadata!.postedAt).toBe("string");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("I.2: an AI.run rejection is logged and does not fail the job/message (log-and-continue)", async () => {
    const company = await seedCompany("embedfail", "Embed Fail Co");
    try {
      const source = await seedSource(company.id, testSlug("embedfail-src"));
      const runId = testSlug("embedfail-run");
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());
      aiRunOverride = async () => {
        throw new Error("Workers AI outage");
      };
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(retried).toEqual([]);

      const jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      expect(await getSignalsForCompany(company.id)).toHaveLength(1);

      expect(vectorizeUpsertCalls).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Embedding failed for job"),
        expect.any(Error),
      );

      consoleError.mockRestore();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("is idempotent: retrying the same runId does not duplicate observations or signals", async () => {
    const company = await seedCompany("idem", "Idempotency Co");
    try {
      const source = await seedSource(company.id, testSlug("idem-src"));
      const runId = testSlug("idem-run");

      const send = async (attempt: number) => {
        const { message, acked } = makeMessage({
          version: 1,
          sourceId: source.id,
          runId,
          requestedAt: new Date().toISOString(),
          attempt,
        });
        const { env } = makeLiveEnv(createLiveD1Database());
        await handleIngestMessage(message, env);
        return acked;
      };

      const acked1 = await send(1);
      const acked2 = await send(1); // same runId, simulating a queue-level retry

      expect(acked1).toEqual([true]);
      expect(acked2).toEqual([true]);

      const jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      expect(await getObservationCount([jobs[0]!.id])).toBe(1);

      const signals = await getSignalsForCompany(company.id);
      expect(signals).toHaveLength(1);
      expect(await getEvidenceForSignals([signals[0]!.id])).toHaveLength(1);

      // Only one source_runs row exists for this runId across both attempts.
      const run = await getSourceRun(runId);
      expect(run).not.toBeNull();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("records job_updated evidence on an active signal when a tracked job's content changes (F4)", async () => {
    const company = await seedCompany("f4", "F4 Update Co");
    try {
      const source = await seedSource(company.id, testSlug("f4-src"));
      const externalId = testSlug("f4-job");

      // Run 1: job seen for the first time -- creates the new_job signal.
      normalizeImpl = vi.fn(() => [makeNormalizedJob(externalId)]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("f4-run1"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      let signals = await getSignalsForCompany(company.id);
      expect(signals).toHaveLength(1);
      const signalId = signals[0]!.id;
      const evidenceAfterRun1 = (await getEvidenceForSignals([signalId])).length;

      // Run 2: same external job id, description text changed -- still
      // present (not absent, not reopened), so lifecycle candidateSignal
      // is undefined and the pipeline would otherwise return early with
      // no evidence at all.
      normalizeImpl = vi.fn(() => [
        { ...makeNormalizedJob(externalId), descriptionText: "Now fully remote, 0-2 years experience." },
      ]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("f4-run2"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      signals = await getSignalsForCompany(company.id);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.id).toBe(signalId);

      const evidenceAfterRun2 = await getEvidenceForSignals([signalId]);
      expect(evidenceAfterRun2).toHaveLength(evidenceAfterRun1 + 1);
      const lastEvidence = evidenceAfterRun2[evidenceAfterRun2.length - 1]!;
      expect(lastEvidence.signal_id).toBe(signalId);
      expect(lastEvidence.evidence_type).toBe("job_updated");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not record job_updated evidence when content changes but nothing is classified/tracked yet", async () => {
    const company = await seedCompany("f4none", "F4 None Co");
    try {
      const source = await seedSource(company.id, testSlug("f4none-src"));
      const externalId = testSlug("f4none-job");

      // Run 1: title/department don't clear the auto-classify threshold,
      // so no signal is ever created for it.
      normalizeImpl = vi.fn(() => [
        { ...makeNormalizedJob(externalId), title: "Mystery Role", department: undefined },
      ]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("f4none-run1"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      expect(await getSignalsForCompany(company.id)).toHaveLength(0);

      // Run 2: content changes, but there's still no active signal to
      // attach evidence to -- the F4 path must be a no-op here.
      normalizeImpl = vi.fn(() => [
        { ...makeNormalizedJob(externalId), title: "Mystery Role", department: undefined, descriptionText: "Updated." },
      ]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("f4none-run2"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      expect(await getSignalsForCompany(company.id)).toHaveLength(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("stays active after one absence, then becomes possibly_closed after a second consecutive absence (spec 5.4)", async () => {
    const company = await seedCompany("lifecycle", "Lifecycle Co");
    try {
      const source = await seedSource(company.id, testSlug("lifecycle-src"));
      const externalId = testSlug("lifecycle-job");

      // Run 1: job is present.
      normalizeImpl = vi.fn(() => [makeNormalizedJob(externalId)]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("lifecycle-run1"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      // Run 2: board returns zero jobs -- one consecutive absence. Per
      // spec 5.4's table, a single absence keeps the job active.
      normalizeImpl = vi.fn(() => []);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("lifecycle-run2"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      let jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe("active");
      expect(jobs[0]!.missing_run_count).toBe(1);

      // Run 3: still absent -- two consecutive absences now, which per
      // spec 5.4 transitions the job to possibly_closed.
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("lifecycle-run3"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      jobs = await getJobsForCompany(company.id);
      expect(jobs[0]!.status).toBe("possibly_closed");
      expect(jobs[0]!.missing_run_count).toBe(2);
      // Three observation rows total: run-1 (present), run-2 (absent), run-3 (absent).
      expect(await getObservationCount([jobs[0]!.id])).toBe(3);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("handleIngestMessage - failure branches (spec 13.4)", () => {
  it("acks (does not retry) when the source no longer exists", async () => {
    // No source seeded -- a random UUID-shaped id that won't match any row.
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: crypto.randomUUID(),
      runId: testSlug("missing-run"),
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    await handleIngestMessage(message, makeLiveEnv(createLiveD1Database()).env);

    expect(acked).toEqual([true]);
    expect(retried).toEqual([]);
  });

  it("429: requeues with delay via queue.send, acks the current message, does not fetch again itself", async () => {
    const company = await seedCompany("f429", "429 Co");
    try {
      const source = await seedSource(company.id, testSlug("f429-src"));
      const runId = testSlug("f429-run");
      fetchBoardImpl = vi.fn(async () => ({
        httpStatus: 429,
        rawBody: undefined,
        retryAfterSeconds: 60,
      }));
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env, sent } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message.attempt).toBe(2);
      expect(sent[0]?.delaySeconds).toBe(60);
      expect((await getSourceRun(runId))?.status).toBe("failed");
      expect(await getJobsForCompany(company.id)).toHaveLength(0);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("transient 5xx: requeues with capped exponential backoff", async () => {
    const company = await seedCompany("f5xx", "5xx Co");
    try {
      const source = await seedSource(company.id, testSlug("f5xx-src"));
      fetchBoardImpl = vi.fn(async () => ({ httpStatus: 503, rawBody: undefined }));
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("f5xx-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env, sent } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.delaySeconds).toBe(30); // BASE_BACKOFF_SECONDS at attempt=1
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("gives up after MAX_RETRY_ATTEMPTS on a persistent 5xx: records failed_final, does not requeue", async () => {
    const company = await seedCompany("fexhaust", "Exhaust Co");
    try {
      const source = await seedSource(company.id, testSlug("fexhaust-src"));
      const runId = testSlug("fexhaust-run");
      fetchBoardImpl = vi.fn(async () => ({ httpStatus: 503, rawBody: undefined }));
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 5, // MAX_RETRY_ATTEMPTS
      });
      const { env, sent } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(sent).toHaveLength(0);
      expect((await getSourceRun(runId))?.status).toBe("failed_final");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("4xx config error: marks source degraded, acks, does not retry", async () => {
    const company = await seedCompany("f4xx", "4xx Co");
    try {
      const source = await seedSource(company.id, testSlug("f4xx-src"));
      const runId = testSlug("f4xx-run");
      fetchBoardImpl = vi.fn(async () => ({ httpStatus: 404, rawBody: undefined }));
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env, sent } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(retried).toEqual([]);
      expect(sent).toHaveLength(0); // not requeued -- a 4xx is not retryable
      expect((await getSourceRun(runId))?.status).toBe("failed");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("unsupported provider: treated as a 4xx-style config error, not a crash", async () => {
    const company = await seedCompany("funsupported", "Unsupported Co");
    try {
      const source = await seedSource(company.id, testSlug("funsupported-src"), "lever");
      const runId = testSlug("funsupported-run");
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect((await getSourceRun(runId))?.status).toBe("failed");
      expect(fetchBoardImpl).not.toHaveBeenCalled();
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("uncaught error mid-pipeline: retries via message.retry() below MAX_RETRY_ATTEMPTS", async () => {
    const company = await seedCompany("funcaught", "Uncaught Co");
    try {
      const source = await seedSource(company.id, testSlug("funcaught-src"));
      normalizeImpl = vi.fn(() => {
        throw new Error("boom: unexpected normalize failure");
      });
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("funcaught-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(retried).toEqual([true]);
      expect(acked).toEqual([]);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("programmer bug mid-pipeline (TypeError): fails fast, does NOT retry (code-review P1 fix)", async () => {
    const company = await seedCompany("fprogbug", "ProgBug Co");
    try {
      const source = await seedSource(company.id, testSlug("fprogbug-src"));
      const runId = testSlug("fprogbug-run");
      normalizeImpl = vi.fn(() => {
        // Simulates a typo/undefined-is-not-a-function class of bug, as
        // opposed to a plain Error, which represents a genuinely
        // transient failure worth retrying.
        throw new TypeError("undefined is not a function");
      });
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1, // well below MAX_RETRY_ATTEMPTS -- must still not retry
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(retried).toEqual([]); // the key assertion: no retry for a programmer error
      const run = await getSourceRun(runId);
      expect(run?.status).toBe("failed_final");
      expect(run?.error_code).toBe("programmer_error");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("invalid provider string in the DB row: config error, not a crash or an unchecked cast (code-review P2 fix)", async () => {
    const company = await seedCompany("finvprovider", "InvProvider Co");
    try {
      const source = await seedSource(company.id, testSlug("finvprovider-src"));
      // No repo write function accepts an invalid provider string, so
      // reach this DB state via a raw UPDATE -- same "DB-level state not
      // reachable through valid repo functions" precedent
      // signals-write-repo.test.ts already established.
      await client.run(`UPDATE sources SET provider = ? WHERE id = ?`, ["not-a-real-provider", source.id]);
      const runId = testSlug("finvprovider-run");
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      expect(retried).toEqual([]);
      expect((await getSourceRun(runId))?.status).toBe("failed");
      expect(fetchBoardImpl).not.toHaveBeenCalled();
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("handleIngestMessage - H.4 company-level signal generation (spec 7.1)", () => {
  it("hiring_burst: 3 new jobs for the same (company, role) in one run triggers a hiring_burst signal", async () => {
    const company = await seedCompany("burst", "Burst Co");
    try {
      const source = await seedSource(company.id, testSlug("burst-src"));
      const p = testSlug("burst-job");
      normalizeImpl = vi.fn(() => [
        makeNormalizedJob(`${p}-1`),
        makeNormalizedJob(`${p}-2`),
        makeNormalizedJob(`${p}-3`),
      ]);
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("burst-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("new_job");
      expect(signalTypes).toContain("hiring_burst");
      expect(signalTypes.filter((t) => t === "hiring_burst")).toHaveLength(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("multi_location: 3 distinct location_modes for the same (company, role) triggers a multi_location signal", async () => {
    const company = await seedCompany("multiloc", "MultiLoc Co");
    try {
      const source = await seedSource(company.id, testSlug("multiloc-src"));
      const p = testSlug("multiloc-job");
      normalizeImpl = vi.fn(() => [
        { ...makeNormalizedJob(`${p}-1`), locationMode: "remote" as const },
        { ...makeNormalizedJob(`${p}-2`), locationMode: "hybrid" as const },
        { ...makeNormalizedJob(`${p}-3`), locationMode: "onsite" as const },
      ]);
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("multiloc-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      expect(acked).toEqual([true]);
      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("multi_location");
      expect(signalTypes.filter((t) => t === "multi_location")).toHaveLength(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("role_acceleration: does NOT trigger on a single job's cold-start acceleration value (regression: false-positive fix)", async () => {
    // computeAcceleration(1, 0) = (1-0)/max(2,0) = 0.5 exactly -- below
    // ROLE_ACCELERATION_MIN_COMPONENT (0.75), so a lone new job must not
    // spuriously read as "accelerating." This is the exact bug caught
    // and fixed during H.4 implementation (threshold raised 0.5 -> 0.75).
    const company = await seedCompany("accel0", "Accel0 Co");
    try {
      const source = await seedSource(company.id, testSlug("accel0-src"));
      normalizeImpl = vi.fn(() => [makeNormalizedJob(testSlug("accel0-job"))]);
      const { message } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("accel0-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      const signals = await getSignalsForCompany(company.id);
      const signalTypes = signals.map((s) => s.signal_type);
      expect(signalTypes).not.toContain("role_acceleration");
      expect(signals).toHaveLength(1); // only the primary new_job signal
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("role_acceleration: 2 new jobs for the same (company, role) in one run saturates acceleration to 1.0 and triggers", async () => {
    // computeAcceleration(2, 0) = (2-0)/max(2,0) = 1.0 -- clears the 0.75
    // threshold. Verifies the trigger path actually fires, not just that
    // it correctly stays silent (previous test).
    const company = await seedCompany("accel1", "Accel1 Co");
    try {
      const source = await seedSource(company.id, testSlug("accel1-src"));
      const p = testSlug("accel1-job");
      normalizeImpl = vi.fn(() => [makeNormalizedJob(`${p}-1`), makeNormalizedJob(`${p}-2`)]);
      const { message } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId: testSlug("accel1-run"),
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      const { env } = makeLiveEnv(createLiveD1Database());

      await handleIngestMessage(message, env);

      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("role_acceleration");
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("persistent_demand: an active new_job signal continuously active >=30 days triggers persistent_demand on the next detection", async () => {
    const company = await seedCompany("persist", "Persist Co");
    try {
      const source = await seedSource(company.id, testSlug("persist-src"));
      const p = testSlug("persist-job");
      normalizeImpl = vi.fn(() => [makeNormalizedJob(`${p}-1`)]);

      // Run 1: creates the primary new_job signal, first_detected_at = now.
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("persist-run1"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      const signalsAfterRun1 = await getSignalsForCompany(company.id);
      const primarySignal = signalsAfterRun1.find((s) => s.signal_type === "new_job");
      expect(primarySignal).toBeDefined();

      // Backdate first_detected_at/last_detected_at by 31 days to
      // simulate the signal having stayed continuously active -- same
      // "DB-level state not reachable through valid repo functions"
      // precedent as reconciliation.test.ts's own status='expired' raw
      // UPDATE. No repo-layer function exists to backdate a signal's
      // detection timestamps (nor should one -- this is purely a test
      // fixture concern).
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      await client.run(
        `UPDATE signals SET first_detected_at = ?, last_detected_at = ? WHERE id = ?`,
        [thirtyOneDaysAgo, thirtyOneDaysAgo, primarySignal!.id],
      );

      // Run 2: a content edit on the same job re-enters
      // processNormalizedJob's classification/signal path only if it's
      // still a new_job/reopened_job lifecycle candidate -- use a
      // genuinely new external job id instead so the lifecycle
      // candidateSignal is "new_job" again, keeping this test focused on
      // the persistent_demand threshold rather than lifecycle edge cases
      // already covered elsewhere.
      normalizeImpl = vi.fn(() => [makeNormalizedJob(`${p}-2`)]);
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("persist-run2"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
      );

      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("persistent_demand");
    } finally {
      await cleanupCompany(company.id);
    }
  });
});
