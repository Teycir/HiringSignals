import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { Message, VectorizeVector } from "@cloudflare/workers-types";
import type { IngestMessage, NormalizedJob } from "@hiring-signals/domain";
import {
  createLiveD1Database,
  createLiveAiBinding,
  createLiveVectorizeIndex,
  createLiveKvNamespace,
} from "@hiring-signals/test-support";
import { createD1Client, createCompany, createSource } from "@hiring-signals/db";
import type { D1Client } from "@hiring-signals/db";
import type * as AdaptersModule from "@hiring-signals/adapters";
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
 *    replaced so `fetchBoard`/`normalize` return scripted values.
 *    **2026-08-06 update (explicit user override of the fetchBoard half
 *    of this exception):** `fetchBoardImpl`'s `beforeEach` default is
 *    now `fetchLiveWarpBoard()` -- a real network call to Warp's public
 *    Greenhouse board (see that function's own doc comment below) --
 *    not a canned payload. Tests that need a specific HTTP status
 *    (429/503/404) or a thrown fetch error still override
 *    `fetchBoardImpl` explicitly per-test, since a real board can't be
 *    made to return those on demand; that part of the original
 *    reasoning still holds. `normalize()` stays fully scripted
 *    regardless of fetchBoard's source, for the same reason.
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
 * `afterAll` sweep as a second pass (2026-08-04: moved off `afterEach`
 * -- see that hook's own comment for why) -- same discipline as every
 * other migrated file in this directory, minus the per-test cadence.
 * Any Vectorize vector written for a cleaned-up job id is also deleted
 * (best-effort) -- the fake this file used to have never had a real
 * vector to clean up before.
 *
 * Wall-clock cost: each live D1 call shells out to a fresh `wrangler d1
 * execute --remote` process (~3.2s per call, mostly wrangler's own CLI
 * startup plus a real Cloudflare network round trip -- confirmed
 * directly 2026-08-04 that `npx`'s own resolution overhead is only
 * ~0.6-0.7s of that, not "almost entirely" as this comment previously
 * said), and `handleIngestMessage`
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

// 30s per-call override (default 15s) for first()/all()/run(), 90s for
// batch() specifically -- J.2: this file's own seed/cleanup/assertion
// client (used by seedCompany, cleanupCompany, getSignalsForCompany,
// etc.) is separate from handleIngestMessage's internal
// createD1Client(env.DB) call -- both need the override, or the
// pipeline itself can succeed while cleanup/setup still hits the
// circuit breaker's default. batch() gets its own, larger value:
// cleanupCompany's 7-statement client.batch([...]) measured 31.7s in
// isolation (no prior calls in the same test), already past the 30s
// value that covers every other call here -- see ROADMAP.md J.2 for
// the isolated-batch measurement that settled this.
const client: D1Client = createD1Client(createLiveD1Database(), {
  operationTimeoutMs: 30_000,
  batchOperationTimeoutMs: 90_000,
});

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

/** The 7 DELETEs run in one client.batch() call -- D1's real atomicity
 * primitive (see lib/d1/client.ts's batch() header comment; D1 has no
 * BEGIN/COMMIT SQL surface via the Workers binding) -- so a mid-sequence
 * process kill can't leave this company's rows half-deleted (data-
 * integrity concern, 2026-08-02). The job-id SELECT stays outside the
 * batch: it only feeds the best-effort Vectorize cleanup below, not
 * another SQL statement, so it isn't part of the atomic unit. */
async function cleanupCompany(companyId: string): Promise<void> {
  const jobRows = await client
    .all<{ id: string }>(`SELECT id FROM jobs WHERE company_id = ?`, [companyId])
    .catch(() => [] as { id: string }[]);
  await client.batch([
    {
      sql: `DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM signals WHERE company_id = ?`, params: [companyId] },
    {
      sql: `DELETE FROM job_observations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM jobs WHERE company_id = ?`, params: [companyId] },
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM sources WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
  await Promise.all(jobRows.map((j) => cleanupVector(j.id)));
}

/**
 * Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` -- matches on the shared TEST_PREFIX.
 *
 * Runs in `afterAll`, not `afterEach` (2026-08-04, to unblock safe
 * `it.concurrent`): this sweep is a *global* prefix match across every
 * `test-ic-%` company, not scoped to the test that just finished. Under
 * `it.concurrent`, an `afterEach` firing after test A finishes would
 * delete rows belonging to test B/C/D while they're still mid-flight
 * (concretely: `FOREIGN KEY constraint failed` on `job_observations`/
 * `signal_evidence` when the sweep deletes a `signals`/`jobs` row a
 * concurrently-running test hasn't finished writing evidence against
 * yet -- reproduced directly before this fix). `afterAll` still catches
 * anything an individual test's own `try/finally { cleanupCompany(...) }`
 * missed (a thrown assertion before that block, a crash mid-test), just
 * once at the very end of the file instead of racing other in-flight
 * tests along the way.
 */
afterAll(async () => {
  const companyRows = await client
    .all<{ id: string }>(`SELECT id FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`])
    .catch(() => [] as { id: string }[]);
  const jobRowsByCompany = await Promise.all(
    companyRows.map((c) =>
      client
        .all<{ id: string }>(`SELECT id FROM jobs WHERE company_id = ?`, [c.id])
        .catch(() => [] as { id: string }[]),
    ),
  );

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
      sql: `DELETE FROM job_observations WHERE job_id IN (
         SELECT id FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)
       )`,
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
/**
 * Explicit function signatures (not the bare `ReturnType<typeof vi.fn>`
 * used before Vitest 4) -- Vitest 4 changed vi.fn()'s default inferred
 * type to a wider `Mock<Procedure | Constructable>` union, which isn't
 * directly callable without a type guard (see Vitest 4 migration guide,
 * "module mocking" changes). Typed against the real contract shapes
 * (AtsAdapter.fetchBoard/.normalize's own declared return types, per
 * adapter-contract.ts) rather than one call site's inferred literal --
 * a literal-typed mock rejected every reassignment elsewhere in this
 * file that varies department/descriptionText/locationMode (all
 * legitimately optional per NormalizedJob), which is the actual bug a
 * first pass at this fix introduced and this corrects.
 */
let fetchBoardImpl: ReturnType<
  typeof vi.fn<() => Promise<AdaptersModule.AdapterFetchResult>>
>;
let normalizeImpl: ReturnType<typeof vi.fn<() => NormalizedJob[]>>;

vi.mock("@hiring-signals/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof AdaptersModule>();
  return {
    ...actual,
    getAdapterForProvider: (provider: string) => {
      if (provider !== "greenhouse") throw new actual.UnsupportedProviderError(provider as never);
      return {
        provider: "greenhouse",
        // Real inputs (SourceConfig/FetchContext, raw/SourceConfig) are
        // intentionally discarded -- fetchBoardImpl/normalizeImpl are
        // scripted zero-arg mocks per-test (see this file's header);
        // no test asserts on the arguments a real adapter would have
        // received here (confirmed: no fetchBoardImpl.mock.calls or
        // normalizeImpl.mock.calls assertion exists in this file).
        fetchBoard: () => fetchBoardImpl(),
        normalize: () => normalizeImpl(),
      };
    },
  };
});

const { handleIngestMessage } = await import("../../src/jobs/ingest-consumer");

/**
 * Real, live fetchBoard() call against Warp's actual public Greenhouse
 * board -- 2026-08-06 policy override (explicit user decision, supersedes
 * this file's original "adapter fully mocked" AGENTS.md exception for the
 * fetchBoard half specifically; normalize() stays scripted below, since a
 * live board can't produce the specific multi-job/backdated/injected-
 * failure scenarios most tests here need on demand).
 *
 * This is the `beforeEach` default for fetchBoardImpl: every test gets a
 * real network round trip to
 * https://boards-api.greenhouse.io/v1/boards/warp/jobs?content=true
 * unless it explicitly overrides fetchBoardImpl itself (the 429/503/404
 * failure-branch tests already do this, unchanged by this override).
 *
 * Known trade-off, accepted per the override decision: this makes the
 * whole file's default path depend on Warp's board staying reachable and
 * on the public Greenhouse API's shape not changing -- consistent with
 * this file's existing live-D1/AI/Vectorize dependencies, just extended
 * to the adapter's network call too.
 */
async function fetchLiveWarpBoard(): Promise<{ httpStatus: number; rawBody: unknown }> {
  const response = await fetch("https://boards-api.greenhouse.io/v1/boards/warp/jobs?content=true", {
    headers: { "User-Agent": "hiring-signals-test-suite", Accept: "application/json" },
  });
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    rawBody = undefined;
  }
  return { httpStatus: response.status, rawBody };
}

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

async function seedSource(
  companyId: string,
  boardToken: string,
  provider: "greenhouse" | "lever" = "greenhouse",
) {
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
/** Overridable per-test: when set, replaces the real VECTORIZE.query call
 * with a rejection, for I.5d's centroid-nudge failure-path test -- same
 * reasoning as aiRunOverride above, the real Vectorize binding has no
 * way to force a query failure on demand. getByIds/upsert are left
 * untouched by this override; only query() (what applyCentroidNudge
 * calls to find the centroid) is affected. */
let vectorizeQueryOverride: (() => Promise<unknown>) | null = null;

function makeLiveEnv(db: Bindings["DB"]): {
  env: Bindings;
  sent: Array<{ message: IngestMessage; delaySeconds?: number }>;
} {
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
        return (realAi as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(
          model,
          inputs,
        );
      },
    } as unknown as Bindings["AI"],
    VECTORIZE: {
      upsert: async (vectors: VectorizeVector[]) => {
        vectorizeUpsertCalls.push(vectors);
        return realVectorize.upsert(vectors);
      },
      query: async (...args: unknown[]) => {
        if (vectorizeQueryOverride) return vectorizeQueryOverride();
        return (
          realVectorize as unknown as { query: (...a: unknown[]) => Promise<unknown> }
        ).query(...args);
      },
      getByIds: (...args: unknown[]) =>
        (
          realVectorize as unknown as { getByIds: (...a: unknown[]) => Promise<unknown> }
        ).getByIds(...args),
    } as unknown as Bindings["VECTORIZE"],
    ENVIRONMENT: "development",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
  };
  return { env, sent };
}

function makeMessage(body: IngestMessage): {
  message: Message<IngestMessage>;
  acked: boolean[];
  retried: boolean[];
} {
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
  // 2026-08-06 policy override: real fetchBoard() by default (see
  // fetchLiveWarpBoard's own doc comment above) -- normalize() stays
  // scripted here since most tests below construct specific job
  // scenarios (multi-job bursts, backdated signals) no live board call
  // can produce on demand.
  fetchBoardImpl = vi.fn(fetchLiveWarpBoard);
  normalizeImpl = vi.fn(() => [makeNormalizedJob()]);
  aiRunOverride = null;
  vectorizeQueryOverride = null;
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
  return client.all<{
    id: string;
    signal_id: string;
    job_id: string | null;
    evidence_type: string;
  }>(
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
        text: [
          "Site Reliability Engineer\nSite Reliability Engineer\nRemote - US\nJoin our infra team.",
        ],
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
        {
          ...makeNormalizedJob(externalId),
          descriptionText: "Now fully remote, 0-2 years experience.",
        },
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
        {
          ...makeNormalizedJob(externalId),
          title: "Mystery Role",
          department: undefined,
          descriptionText: "Updated.",
        },
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
      await client.run(`UPDATE sources SET provider = ? WHERE id = ?`, [
        "not-a-real-provider",
        source.id,
      ]);
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
  // ROADMAP.md J.1 (2026-08-04): 240s per-test override, not a global
  // vitest.config.ts bump -- this file's H.4 tests seed 2-3 jobs each,
  // and each job pays roughly 14-26 sequential live-D1 round trips
  // (~3s/call process-spawn overhead each, measured directly against
  // real D1 -- see J.1's investigation earlier in this file), so a
  // 3-job test's worst-case cost is well past the workspace's default
  // 90s testTimeout even after J.1 steps 1/4/6 (read-batching +
  // read-concurrency) landed -- those measurably did NOT close the gap
  // (role_acceleration's 2-job case took 115.8s in one observed run,
  // scoped tests still timed out at 90s in another). Root cause
  // (sequential per-job writes) not yet fixed -- this override is the
  // "cheapest" option from AGENTS.md's original cost-ordering note,
  // applied deliberately per-test rather than globally so a genuine
  // hang in an unrelated apps/api test file (e.g. scheduler.test.ts)
  // still fails fast at the workspace default instead of being masked
  // by a blanket timeout increase.
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

      // 30s per-call override (default 15s) -- J.2: this session's live D1
      // per-call latency exceeded the circuit breaker's default before
      // testTimeout was even reached. See ROADMAP.md J.2.
      await handleIngestMessage(message, env, 30_000);

      expect(acked).toEqual([true]);
      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("new_job");
      expect(signalTypes).toContain("hiring_burst");
      expect(signalTypes.filter((t) => t === "hiring_burst")).toHaveLength(1);
    } finally {
      await cleanupCompany(company.id);
    }
  }, 240_000);

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

      // 30s per-call override (default 15s) -- J.2. See ROADMAP.md J.2.
      await handleIngestMessage(message, env, 30_000);

      expect(acked).toEqual([true]);
      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("multi_location");
      expect(signalTypes.filter((t) => t === "multi_location")).toHaveLength(1);
    } finally {
      await cleanupCompany(company.id);
    }
  }, 240_000);

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

      // 30s per-call override (default 15s) -- J.2. See ROADMAP.md J.2.
      await handleIngestMessage(message, env, 30_000);

      const signals = await getSignalsForCompany(company.id);
      const signalTypes = signals.map((s) => s.signal_type);
      expect(signalTypes).not.toContain("role_acceleration");
      expect(signals).toHaveLength(1); // only the primary new_job signal
    } finally {
      await cleanupCompany(company.id);
    }
  }, 240_000);

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

      // 30s per-call override (default 15s) -- J.2. See ROADMAP.md J.2.
      await handleIngestMessage(message, env, 30_000);

      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("role_acceleration");
    } finally {
      await cleanupCompany(company.id);
    }
  }, 240_000);

  it("persistent_demand: an active new_job signal continuously active >=30 days triggers persistent_demand on the next detection", async () => {
    const company = await seedCompany("persist", "Persist Co");
    try {
      const source = await seedSource(company.id, testSlug("persist-src"));
      const p = testSlug("persist-job");
      normalizeImpl = vi.fn(() => [makeNormalizedJob(`${p}-1`)]);

      // Run 1: creates the primary new_job signal, first_detected_at = now.
      // 30s per-call override (default 15s) -- J.2. See ROADMAP.md J.2.
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("persist-run1"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
        30_000,
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
      // 30s per-call override (default 15s) -- J.2. See ROADMAP.md J.2.
      await handleIngestMessage(
        makeMessage({
          version: 1,
          sourceId: source.id,
          runId: testSlug("persist-run2"),
          requestedAt: new Date().toISOString(),
          attempt: 1,
        }).message,
        makeLiveEnv(createLiveD1Database()).env,
        30_000,
      );

      const signalTypes = (await getSignalsForCompany(company.id)).map((s) => s.signal_type);
      expect(signalTypes).toContain("persistent_demand");
    } finally {
      await cleanupCompany(company.id);
    }
  }, 300_000); // two full handleIngestMessage passes (run 1 + run 2) -- more headroom than the single-run H.4 tests above.
});

/**
 * I.5d: integration coverage for I.5c's wiring (applyCentroidNudge inside
 * processNormalizedJob). The pure nudge arithmetic itself
 * (applyClassificationAssist) is already fully unit-tested in
 * packages/domain/test/classification-assist.test.ts (9/9, per I.5b) --
 * these two tests cover the piece that file structurally cannot: the
 * real live-D1/AI/Vectorize wiring, i.e. does classifyJob's low-
 * confidence result actually reach the nudge, and does a nudge failure
 * actually degrade gracefully inside the real pipeline (not just in a
 * mocked unit).
 *
 * "Security Engineer" is used as the low-confidence title throughout:
 * title-only match caps at WEIGHT_TITLE = 0.70 (classification.ts) with
 * no department/description corroboration, landing it just under
 * AUTO_CLASSIFY_THRESHOLD (0.80) and squarely in NUDGE_ELIGIBLE_BELOW_CONFIDENCE's
 * band -- confirmed against role-rules.ts's own PHRASE_RULES entry
 * ("security engineer" -> cybersecurity), not an invented title. Chosen
 * over a synthetic/ambiguous title specifically so classification.rolePrimary
 * is deterministically "cybersecurity" every run, keeping these two tests
 * about the nudge wiring, not about classification's own edge cases
 * (already covered by classification.test.ts).
 */
describe("handleIngestMessage - I.5c/I.5d classification-assist nudge (spec 9.4)", () => {
  it("nudges a low-confidence classification via the live centroid index and persists the nudged confidence", async () => {
    const company = await seedCompany("nudge", "Nudge Co");
    try {
      const source = await seedSource(company.id, testSlug("nudge-src"));
      const externalId = testSlug("nudge-job");
      normalizeImpl = vi.fn(() => [
        {
          ...makeNormalizedJob(externalId),
          title: "Security Engineer",
          department: undefined,
          descriptionText: undefined,
        },
      ]);
      const runId = testSlug("nudge-run");
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });

      await handleIngestMessage(message, makeLiveEnv(createLiveD1Database()).env, 30_000);

      expect(acked).toEqual([true]);

      const jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.role_primary).toBe("cybersecurity");
      // The pre-nudge confidence for a title-only match is exactly 0.70
      // (WEIGHT_TITLE, classification.ts). A live centroid lookup ran
      // and adjusted it by some non-zero amount in either direction
      // (MAX_NUDGE_MAGNITUDE = 0.05, classification-assist.ts) -- this
      // assertion is deliberately a not-exactly-0.70 check rather than
      // pinned to one exact float, since the real embedding model's
      // cosine similarity to the live centroid is not something this
      // test controls or should hardcode.
      expect(job.classification_confidence).not.toBeNull();
      expect(job.classification_confidence).not.toBe(0.7);
      expect(job.classification_confidence).toBeGreaterThanOrEqual(0.65);
      expect(job.classification_confidence).toBeLessThanOrEqual(0.75);

      // A live query() call actually reached Vectorize for this job --
      // confirms the nudge path ran, not just that classification wrote
      // some value coincidentally close to 0.70.
      expect(vectorizeUpsertCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupCompany(company.id);
    }
  }, 150_000); // Corrected from the file's 90s default (2026-08-06): a
  // single handleIngestMessage pass here measured 55-81s on its own
  // (real Workers AI embed + live centroid Vectorize query), and this
  // file's own cleanupCompany teardown batch is separately documented
  // (J.2) at ~31.7s in isolation -- combined, both real runs of this
  // test exceeded the 90s default even though the pipeline itself
  // always completed well inside it. Same fix already applied to the
  // H.4 persistent_demand test above for the same reason.

  it("I.5d: a VECTORIZE.query rejection during the nudge lookup is logged and does not block classification (log-and-continue)", async () => {
    const company = await seedCompany("nudgefail", "Nudge Fail Co");
    try {
      const source = await seedSource(company.id, testSlug("nudgefail-src"));
      const externalId = testSlug("nudgefail-job");
      normalizeImpl = vi.fn(() => [
        {
          ...makeNormalizedJob(externalId),
          title: "Security Engineer",
          department: undefined,
          descriptionText: undefined,
        },
      ]);
      const runId = testSlug("nudgefail-run");
      const { message, acked, retried } = makeMessage({
        version: 1,
        sourceId: source.id,
        runId,
        requestedAt: new Date().toISOString(),
        attempt: 1,
      });
      vectorizeQueryOverride = async () => {
        throw new Error("Vectorize outage");
      };
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      await handleIngestMessage(message, makeLiveEnv(createLiveD1Database()).env, 30_000);

      // Message-handling contract unchanged by a nudge failure: still
      // acked, never retried -- same log-and-continue guarantee I.2's
      // embedding-failure test asserts for AI.run.
      expect(acked).toEqual([true]);
      expect(retried).toEqual([]);

      const jobs = await getJobsForCompany(company.id);
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      // Deterministic classification still ran and still wrote a result
      // -- classification is never gated on the nudge succeeding.
      expect(job.role_primary).toBe("cybersecurity");
      // Nudge lookup failed before producing any adjustment, so
      // applyCentroidNudge's own catch block returns the original,
      // un-nudged confidence unchanged: exactly 0.70, not a range.
      expect(job.classification_confidence).toBe(0.7);
      // Still below AUTO_CLASSIFY_THRESHOLD (0.80) -- no signal created
      // for this job, since 0.70 alone was never enough on its own.
      expect(await getSignalsForCompany(company.id)).toHaveLength(0);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Classification-assist nudge failed for job"),
        expect.any(Error),
      );

      consoleError.mockRestore();
    } finally {
      await cleanupCompany(company.id);
    }
  }, 150_000); // Same 150s override and reasoning as the nudge test
  // above -- this test's own pipeline pass measured 59-75s.
});
