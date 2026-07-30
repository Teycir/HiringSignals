import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Message, VectorizeVector } from "@cloudflare/workers-types";
import type { IngestMessage } from "@hiring-signals/domain";
import type { Bindings } from "../../src/bindings";

/**
 * Purpose-built in-memory D1 fake for the ingest-consumer's end-to-end
 * pipeline test. Routes each query by matching on distinctive substrings
 * in the SQL text (same "assert on shape, not a real engine" spirit as
 * packages/db/test/signals-write-repo.test.ts) rather than parsing SQL
 * generically -- a hand-parsed SQL engine would be its own source of
 * bugs and could mask real regressions behind fake-parser bugs. Each
 * repo function's own exact SQL/param shape is independently covered by
 * packages/db's unit tests; this fake only needs to reproduce the
 * specific relational behaviors the consumer's idempotency contract
 * depends on: (1) jobs upsert-by-(source_id, external_job_id), (2)
 * job_observations' UNIQUE(job_id, source_run_id) constraint, (3)
 * source_runs keyed by id (reused across retries of the same runId),
 * (4) signals dedup by (company_id, role_category, signal_type,
 * status='active').
 */
interface Row {
  [key: string]: unknown;
}

function createFakeState() {
  return {
    sources: new Map<string, Row>(),
    jobsByKey: new Map<string, Row>(), // "sourceId::externalJobId" -> row
    jobsById: new Map<string, Row>(),
    observationKeys: new Set<string>(), // "jobId::sourceRunId"
    observationCount: 0,
    sourceRuns: new Map<string, Row>(),
    signals: new Map<string, Row>(), // "companyId::role::type" -> active signal row
    signalsById: new Map<string, Row>(),
    evidenceCount: 0,
    evidenceRows: [] as Row[],
  };
}

type FakeState = ReturnType<typeof createFakeState>;

function makeFakeClient(state: FakeState) {
  return {
    async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      if (sql.includes("FROM sources WHERE id")) {
        return (state.sources.get(params[0] as string) as T) ?? null;
      }
      if (sql.includes("SELECT id, content_hash FROM jobs WHERE source_id")) {
        const key = `${params[0]}::${params[1]}`;
        const row = state.jobsByKey.get(key);
        return row ? ({ id: row.id, content_hash: row.content_hash } as T) : null;
      }
      if (sql.includes("SELECT id, status, missing_run_count, first_seen_at, role_primary FROM jobs")) {
        const key = `${params[0]}::${params[1]}`;
        return (state.jobsByKey.get(key) as T) ?? null;
      }
      if (sql.includes("FROM source_runs WHERE source_id")) {
        const row = state.sourceRuns.get(params[1] as string);
        return row ? ({ id: row.id } as T) : null;
      }
      if (sql.includes("FROM signals") && sql.includes("status = 'active'")) {
        const key = `${params[0]}::${params[1]}::${params[2]}`;
        return (state.signals.get(key) as T) ?? null;
      }
      // H.3: getCompanyRoleActivityStats (packages/db/src/company-role-stats-repo.ts).
      // Disambiguated from getJobsMissingFromRun's similar "status IN
      // ('active', 'possibly_closed')" substring by SUM(CASE, which only
      // this single-row conditional-aggregation query uses. Real
      // (non-zero) counts here matter: without this branch the fake
      // falls through to `return null`, and the repo's null-coalescing
      // (`row?.x ?? 0`) would silently return all zeros -- the happy-path
      // test would then never actually exercise real V/A/B computation,
      // just quietly re-test the old v1 zero-equivalent path under a v2
      // label. Counts derived from state.jobsById to reflect whatever
      // the test's own fixtures have set up by this point in the run.
      if (sql.includes("SUM(CASE WHEN status IN")) {
        const companyId = params[params.length - 2] as string;
        const roleCategory = params[params.length - 1] as string;
        let activeMatchingCount = 0;
        const locations = new Set<string>();
        for (const row of state.jobsById.values()) {
          if (row.company_id !== companyId || row.role_primary !== roleCategory) continue;
          if (row.status === "active" || row.status === "possibly_closed") {
            activeMatchingCount++;
            locations.add(
              `${row.country_code}::${row.region_code}::${row.city}::${row.location_mode}`,
            );
          }
        }
        const distinctLocationCount = locations.size;
        return {
          active_matching_count: activeMatchingCount,
          new_in_last_14_days: activeMatchingCount, // fixtures are freshly created within the window
          new_in_prior_56_days: 0,
          distinct_location_count: distinctLocationCount,
        } as T;
      }
      return null;
    },

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("FROM jobs") && sql.includes("status IN ('active', 'possibly_closed')")) {
        const sourceId = params[0] as string;
        const seenExternalIds = new Set(params.slice(1) as string[]);
        const missing: Row[] = [];
        for (const row of state.jobsById.values()) {
          if (row.source_id !== sourceId) continue;
          if (row.status !== "active" && row.status !== "possibly_closed") continue;
          if (seenExternalIds.has(row.external_job_id as string)) continue;
          missing.push(row);
        }
        return missing as T[];
      }
      return [];
    },

    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      // --- source_runs insert (resolveSourceRunId) ---
      if (sql.includes("INSERT INTO source_runs")) {
        const [id, sourceId, startedAt] = params as [string, string, string];
        state.sourceRuns.set(id, {
          id,
          source_id: sourceId,
          started_at: startedAt,
          status: "running",
        });
        return { changes: 1 };
      }

      // --- source_runs completion (recordSourceRunComplete) ---
      if (sql.includes("UPDATE source_runs")) {
        const sourceRunId = params[params.length - 1] as string;
        const existing = state.sourceRuns.get(sourceRunId) ?? {};
        state.sourceRuns.set(sourceRunId, {
          ...existing,
          completed_at: params[0],
          status: params[1],
          http_status: params[2],
          jobs_received: params[3],
          jobs_normalized: params[4],
          error_code: params[5],
          error_message_safe: params[6],
          raw_payload_key: params[7],
          duration_ms: params[8],
        });
        return { changes: 1 };
      }

      // --- jobs upsert (upsertJob: UPDATE branch) ---
      if (sql.includes("UPDATE jobs SET") && sql.includes("canonical_url = ?")) {
        const id = params[params.length - 1] as string;
        const existing = state.jobsById.get(id);
        if (existing) {
          existing.canonical_url = params[0];
          existing.title_raw = params[1];
          existing.title_normalized = params[2];
          existing.description_text = params[3];
          existing.department_raw = params[4];
          existing.employment_type = params[5];
          existing.location_raw = params[6];
          existing.location_mode = params[7];
          existing.last_seen_at = params[13];
          existing.content_hash = params[14];
        }
        return { changes: 1 };
      }

      // --- jobs insert (upsertJob: INSERT branch) ---
      if (sql.includes("INSERT INTO jobs")) {
        const [
          id,
          sourceId,
          companyId,
          externalJobId,
          canonicalUrl,
          title,
          titleNormalized,
          descriptionText,
          department,
          employmentType,
          locationRaw,
          locationMode,
          , // country_code
          , // region_code
          , // city
          postedAt,
          sourceUpdatedAt,
          observedAtFirst,
          observedAtLast,
          contentHash,
        ] = params as [
          string, string, string, string, string, string, string,
          string | undefined, string | undefined, string | undefined,
          string | undefined, string | undefined,
          undefined, undefined, undefined,
          string | undefined, string | undefined, string, string, string,
        ];
        const row: Row = {
          id,
          source_id: sourceId,
          company_id: companyId,
          external_job_id: externalJobId,
          canonical_url: canonicalUrl,
          title_raw: title,
          title_normalized: titleNormalized,
          description_text: descriptionText,
          department_raw: department,
          employment_type: employmentType,
          location_raw: locationRaw,
          location_mode: locationMode,
          role_primary: null,
          classification_confidence: null,
          classification_version: null,
          posted_at: postedAt,
          source_updated_at: sourceUpdatedAt,
          first_seen_at: observedAtFirst,
          last_seen_at: observedAtLast,
          missing_run_count: 0,
          status: "active",
          content_hash: contentHash,
        };
        state.jobsById.set(id, row);
        state.jobsByKey.set(`${sourceId}::${externalJobId}`, row);
        return { changes: 1 };
      }

      // --- job_observations insert (insertJobObservation) ---
      if (sql.includes("INSERT INTO job_observations")) {
        const [, jobId, sourceRunId] = params as string[];
        const key = `${jobId}::${sourceRunId}`;
        if (state.observationKeys.has(key)) {
          throw new Error("UNIQUE constraint failed: job_observations.job_id, job_observations.source_run_id");
        }
        state.observationKeys.add(key);
        state.observationCount++;
        return { changes: 1 };
      }

      // --- lifecycle write (applyLifecycleTransition) ---
      if (sql.includes("UPDATE jobs SET status = ?, missing_run_count = ?, last_seen_at = ?")) {
        const [status, missingRunCount, lastSeenAt, jobId] = params as [string, number, string, string];
        const row = state.jobsById.get(jobId);
        if (row) {
          row.status = status;
          row.missing_run_count = missingRunCount;
          row.last_seen_at = lastSeenAt;
        }
        return { changes: 1 };
      }
      if (sql.includes("UPDATE jobs SET status = ?, missing_run_count = ?")) {
        const [status, missingRunCount, jobId] = params as [string, number, string];
        const row = state.jobsById.get(jobId);
        if (row) {
          row.status = status;
          row.missing_run_count = missingRunCount;
        }
        return { changes: 1 };
      }

      // --- classification write ---
      if (sql.includes("UPDATE jobs SET role_primary")) {
        const [rolePrimary, confidence, version, jobId] = params as [string, number, string, string];
        const row = state.jobsById.get(jobId);
        if (row) {
          row.role_primary = rolePrimary;
          row.classification_confidence = confidence;
          row.classification_version = version;
        }
        return { changes: 1 };
      }

      // --- signals insert (createSignal) ---
      if (sql.includes("INSERT INTO signals")) {
        const [id, companyId, roleCategory, signalType] = params as [string, string, string, string];
        const row: Row = {
          id,
          company_id: companyId,
          role_category: roleCategory,
          signal_type: signalType,
          score: params[4],
          score_version: params[5],
          first_detected_at: params[6],
          last_detected_at: params[7],
          headline: params[8],
          summary: params[9],
          status: "active",
        };
        state.signalsById.set(id, row);
        state.signals.set(`${companyId}::${roleCategory}::${signalType}`, row);
        return { changes: 1 };
      }

      // --- signals refresh (refreshSignal) ---
      if (sql.includes("UPDATE signals SET score = ?")) {
        const [score, scoreVersion, lastDetectedAt, signalId] = params as [string, string, string, string];
        const row = state.signalsById.get(signalId);
        if (row) {
          row.score = score;
          row.score_version = scoreVersion;
          row.last_detected_at = lastDetectedAt;
        }
        return { changes: 1 };
      }

      // --- signal_evidence insert (appendSignalEvidence) ---
      if (sql.includes("INSERT INTO signal_evidence")) {
        state.evidenceCount++;
        const [, signalId, jobId, evidenceType, observedAt, payloadJson] = params as [
          string, string, string | null, string, string, string,
        ];
        state.evidenceRows.push({
          signal_id: signalId,
          job_id: jobId,
          evidence_type: evidenceType,
          observed_at: observedAt,
          payload_json: payloadJson,
        });
        return { changes: 1 };
      }

      // --- source degraded / disabled / success (updateSource, markSourceSuccess, markSourceFailure) ---
      if (sql.includes("UPDATE sources")) {
        return { changes: 1 };
      }

      throw new Error(`Fake D1 client: unhandled SQL in run(): ${sql}`);
    },

    async batch<T>(): Promise<T[][]> {
      return [];
    },
  };
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

vi.mock("../../src/services/raw-payload-store", () => ({
  storeRawPayload: vi.fn(async () => "raw:src-1:run-1"),
  rawPayloadKey: (sourceId: string, runId: string) => `raw:${sourceId}:${runId}`,
}));

const { handleIngestMessage } = await import("../../src/jobs/ingest-consumer");

function makeSourceRow(id = "src-1"): Row {
  return {
    id,
    company_id: "co-1",
    provider: "greenhouse",
    board_token: "tok",
    public_url: "https://example.com",
    enabled: 1,
    poll_interval_minutes: 60,
    next_poll_at: null,
    last_success_at: null,
    consecutive_failures: 0,
  };
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
 * Stand-in for a binding this test never legitimately touches directly
 * (DB, CACHE) -- the real value goes through the "@hiring-signals/db"
 * mock below (createD1Client is replaced with a zero-arg function that
 * ignores whatever's passed to it, see the vi.mock call), so today
 * nothing ever reads DB/CACHE's own properties. A bare `{} as unknown
 * as T` would make that safe-by-accident: if a future change to this
 * test file ever removed or narrowed that mock, the first real property
 * access (e.g. `env.DB.prepare`) would fail with a confusing "is not a
 * function" instead of a clear signal that the binding was never faked
 * (code-review P3 finding). A Proxy that throws on any trap makes that
 * failure loud and immediate instead.
 */
function unusedBinding<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `Test bug: accessed ${name}.${String(prop)}, but ${name} is an unusedBinding() ` +
            `placeholder -- this binding is expected to only be reached through a mocked ` +
            `module (see the vi.mock("@hiring-signals/db", ...) call in this file), not read ` +
            `directly. If this test now needs a real ${name}, replace unusedBinding("${name}") ` +
            `with an actual fake.`,
        );
      },
    },
  ) as T;
}

/**
 * Records of calls into the fake AI/VECTORIZE bindings, reset per test
 * via makeFakeEnv() (fresh arrays each call, same pattern as `sent`
 * below for INGEST_QUEUE). Module-level so I.2's happy/failure-path
 * tests can inspect them without makeFakeEnv() needing to return yet
 * another destructured field that every other existing test in this
 * file would then have to ignore.
 */
let aiRunCalls: Array<{ model: string; inputs: unknown }> = [];
let vectorizeUpsertCalls: Array<VectorizeVector[]> = [];
/** Overridable per-test: defaults to a realistic 768-dim embedding success; I.2's failure-path test replaces this with a rejection. */
let aiRunImpl: () => Promise<{ data: number[][] }> = async () => ({
  data: [new Array(768).fill(0.01)],
});

function makeFakeEnv(): { env: Bindings; sent: Array<{ message: IngestMessage; delaySeconds?: number }> } {
  const sent: Array<{ message: IngestMessage; delaySeconds?: number }> = [];
  aiRunCalls = [];
  vectorizeUpsertCalls = [];
  const env = {
    DB: unusedBinding<Bindings["DB"]>("DB"),
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    RAW_PAYLOADS: unusedBinding<Bindings["RAW_PAYLOADS"]>("RAW_PAYLOADS"),
    ABUSE_LOGS: unusedBinding<Bindings["ABUSE_LOGS"]>("ABUSE_LOGS"),
    INGEST_QUEUE: {
      send: async (message: IngestMessage, options?: { delaySeconds?: number }) => {
        sent.push({ message, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Bindings["INGEST_QUEUE"],
    AI: {
      run: async (model: string, inputs: unknown) => {
        aiRunCalls.push({ model, inputs });
        return aiRunImpl();
      },
    } as unknown as Bindings["AI"],
    VECTORIZE: {
      upsert: async (vectors: VectorizeVector[]) => {
        vectorizeUpsertCalls.push(vectors);
        return { ids: vectors.map((v) => v.id), count: vectors.length };
      },
    } as unknown as Bindings["VECTORIZE"],
    ENVIRONMENT: "development" as const,
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

let currentState: FakeState;

vi.mock("@hiring-signals/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hiring-signals/db")>();
  return {
    ...actual,
    createD1Client: () => makeFakeClient(currentState),
  };
});

beforeEach(() => {
  currentState = createFakeState();
  fetchBoardImpl = vi.fn(async () => ({ httpStatus: 200, rawBody: { jobs: [] } }));
  normalizeImpl = vi.fn(() => [makeNormalizedJob()]);
  aiRunImpl = async () => ({ data: [new Array(768).fill(0.01)] });
});

describe("handleIngestMessage - happy path", () => {
  it("runs the full pipeline: upsert, observation, lifecycle, classification, signal creation", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);

    // Job upserted.
    expect(currentState.jobsByKey.size).toBe(1);
    const job = [...currentState.jobsByKey.values()][0]!;
    expect(job.status).toBe("active");
    expect(job.role_primary).toBe("cloud_platform_devops_sre");
    expect(job.classification_confidence).toBeCloseTo(0.9, 5);

    // One observation recorded for (job, run).
    expect(currentState.observationCount).toBe(1);

    // Signal created (auto-classified, new_job candidate on first sight).
    expect(currentState.signalsById.size).toBe(1);
    const signal = [...currentState.signalsById.values()][0]!;
    expect(signal.company_id).toBe("co-1");
    expect(signal.role_category).toBe("cloud_platform_devops_sre");
    expect(signal.signal_type).toBe("new_job");
    expect(currentState.evidenceCount).toBe(1);

    // source_runs row closed out as success.
    const run = currentState.sourceRuns.get("run-1");
    expect(run?.status).toBe("success");
  });

  it("I.2: embeds a new job and upserts the vector with the documented metadata shape (spec §9.4)", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);

    // AI.run called once with the model from EMBEDDING_MODEL and the
    // built embedding text as a single-element array (per
    // buildJobEmbeddingText/Ai_Cf_Baai_Bge_Base_En_V1_5_Input's `text:
    // string | string[]` shape).
    expect(aiRunCalls).toHaveLength(1);
    expect(aiRunCalls[0]!.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(aiRunCalls[0]!.inputs).toEqual({
      text: ["Site Reliability Engineer\nSite Reliability Engineer\nRemote - US\nJoin our infra team."],
    });

    // VECTORIZE.upsert called once, vector ID = the job's own D1 id
    // (mirrors ArxivExplorer's "vector ID = bare arXiv ID" choice),
    // metadata carrying the documented filter fields. roleCategory is
    // absent here: at embed time (right after applyLifecycleTransition,
    // before classifyJob runs) this is a brand-new job's *first*
    // embedding, so it has no prior classification to report yet --
    // that's expected, not a bug (see embedAndUpsertJob's doc comment).
    expect(vectorizeUpsertCalls).toHaveLength(1);
    const [vector] = vectorizeUpsertCalls[0]!;
    const job = [...currentState.jobsByKey.values()][0]!;
    expect(vector!.id).toBe(job.id);
    expect(vector!.values).toHaveLength(768);
    expect(vector!.metadata).toMatchObject({
      companyId: "co-1",
      status: "active",
      locationMode: "remote",
    });
    expect(vector!.metadata).not.toHaveProperty("roleCategory");
    expect(typeof vector!.metadata!.postedAt).toBe("string");
  });

  it("I.2: an AI.run rejection is logged and does not fail the job/message (log-and-continue)", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();
    aiRunImpl = async () => {
      throw new Error("Workers AI outage");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleIngestMessage(message, env);

    // Message still acked, not retried: an embedding failure must not
    // be treated like an ATS-fetch failure (spec's I.5 guardrail,
    // applied one milestone early -- see embedAndUpsertJob's doc
    // comment for why this is a deliberate asymmetry).
    expect(acked).toEqual([true]);
    expect(retried).toEqual([]);

    // Job still fully ingested/classified/scored despite the embedding
    // failure -- this is the entire point of log-and-continue.
    expect(currentState.jobsByKey.size).toBe(1);
    expect(currentState.signalsById.size).toBe(1);

    // Vectorize never reached (AI.run failed first), and the failure
    // was logged rather than silently swallowed.
    expect(vectorizeUpsertCalls).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Embedding failed for job"),
      expect.any(Error),
    );

    consoleError.mockRestore();
  });

  it("is idempotent: retrying the same runId does not duplicate observations or signals", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));

    const send = async (attempt: number) => {
      const { message, acked } = makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-1",
        requestedAt: new Date().toISOString(),
        attempt,
      });
      const { env } = makeFakeEnv();
      await handleIngestMessage(message, env);
      return acked;
    };

    const acked1 = await send(1);
    const acked2 = await send(1); // same runId, simulating a queue-level retry

    expect(acked1).toEqual([true]);
    expect(acked2).toEqual([true]);

    // Still exactly one job, one observation, one signal, one evidence
    // row -- the retry must not duplicate any of them (spec 13.3).
    expect(currentState.jobsByKey.size).toBe(1);
    expect(currentState.observationCount).toBe(1);
    expect(currentState.signalsById.size).toBe(1);
    expect(currentState.evidenceCount).toBe(1);

    // Only one source_runs row exists for this runId across both attempts.
    expect(currentState.sourceRuns.size).toBe(1);
  });

  it("records job_updated evidence on an active signal when a tracked job's content changes (F4)", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));

    // Run 1: job seen for the first time -- creates the new_job signal
    // (same setup as the happy-path test).
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-1")]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-1",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    expect(currentState.signalsById.size).toBe(1);
    const signalId = [...currentState.signalsById.keys()][0]!;
    const evidenceAfterRun1 = currentState.evidenceCount;

    // Run 2: same external job id, but the description text changed --
    // still present (not absent, not reopened), so this run's lifecycle
    // candidateSignal is undefined and the pipeline would otherwise
    // return early with no evidence at all.
    normalizeImpl = vi.fn(() => [
      { ...makeNormalizedJob("job-ext-1"), descriptionText: "Now fully remote, 0-2 years experience." },
    ]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-2",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    // No new signal was created or duplicated -- still the same one row.
    expect(currentState.signalsById.size).toBe(1);
    expect([...currentState.signalsById.keys()][0]).toBe(signalId);

    // Exactly one additional evidence row was appended, typed job_updated,
    // attached to the existing signal.
    expect(currentState.evidenceCount).toBe(evidenceAfterRun1 + 1);
    const lastEvidence = currentState.evidenceRows[currentState.evidenceRows.length - 1]!;
    expect(lastEvidence.signal_id).toBe(signalId);
    expect(lastEvidence.evidence_type).toBe("job_updated");
  });

  it("does not record job_updated evidence when content changes but nothing is classified/tracked yet", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));

    // Run 1: a job whose title/department don't clear the auto-classify
    // threshold, so no signal is ever created for it (role_primary stays
    // null on the row -- see updateJobClassification).
    normalizeImpl = vi.fn(() => [
      { ...makeNormalizedJob("job-ext-1"), title: "Mystery Role", department: undefined },
    ]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-1",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    expect(currentState.signalsById.size).toBe(0);
    const evidenceAfterRun1 = currentState.evidenceCount;

    // Run 2: content changes, but there's still no active signal to
    // attach evidence to -- the F4 path must be a no-op here.
    normalizeImpl = vi.fn(() => [
      { ...makeNormalizedJob("job-ext-1"), title: "Mystery Role", department: undefined, descriptionText: "Updated." },
    ]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-2",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    expect(currentState.evidenceCount).toBe(evidenceAfterRun1);
    expect(currentState.signalsById.size).toBe(0);
  });

  it("stays active after one absence, then becomes possibly_closed after a second consecutive absence (spec 5.4)", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));

    // Run 1: job is present.
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-1")]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-1",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    // Run 2: board returns zero jobs -- one consecutive absence. Per spec
    // 5.4's table, a single absence keeps the job active.
    normalizeImpl = vi.fn(() => []);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-2",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    let job = [...currentState.jobsByKey.values()][0]!;
    expect(job.status).toBe("active");
    expect(job.missing_run_count).toBe(1);

    // Run 3: still absent -- two consecutive absences now, which per spec
    // 5.4 transitions the job to possibly_closed.
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-3",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    job = [...currentState.jobsByKey.values()][0]!;
    expect(job.status).toBe("possibly_closed");
    expect(job.missing_run_count).toBe(2);
    // Three observation rows total: run-1 (present), run-2 (absent), run-3 (absent).
    expect(currentState.observationCount).toBe(3);
  });
});

describe("handleIngestMessage - failure branches (spec 13.4)", () => {
  it("acks (does not retry) when the source no longer exists", async () => {
    // No source seeded for "src-missing".
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-missing",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    await handleIngestMessage(message, makeFakeEnv().env);

    expect(acked).toEqual([true]);
    expect(retried).toEqual([]);
  });

  it("429: requeues with delay via queue.send, acks the current message, does not fetch again itself", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    fetchBoardImpl = vi.fn(async () => ({
      httpStatus: 429,
      rawBody: undefined,
      retryAfterSeconds: 60,
    }));
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env, sent } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]); // current message acked; retry carried by the re-enqueued message
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.attempt).toBe(2);
    expect(sent[0]?.delaySeconds).toBe(60);
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed");

    // No job/signal was written on a failed fetch.
    expect(currentState.jobsByKey.size).toBe(0);
  });

  it("transient 5xx: requeues with capped exponential backoff", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    fetchBoardImpl = vi.fn(async () => ({ httpStatus: 503, rawBody: undefined }));
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env, sent } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delaySeconds).toBe(30); // BASE_BACKOFF_SECONDS at attempt=1
  });

  it("gives up after MAX_RETRY_ATTEMPTS on a persistent 5xx: records failed_final, does not requeue", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    fetchBoardImpl = vi.fn(async () => ({ httpStatus: 503, rawBody: undefined }));
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 5, // MAX_RETRY_ATTEMPTS
    });
    const { env, sent } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(sent).toHaveLength(0);
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed_final");
  });

  it("4xx config error: marks source degraded, acks, does not retry", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    fetchBoardImpl = vi.fn(async () => ({ httpStatus: 404, rawBody: undefined }));
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env, sent } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(retried).toEqual([]);
    expect(sent).toHaveLength(0); // not requeued -- a 4xx is not retryable
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed");
  });

  it("unsupported provider: treated as a 4xx-style config error, not a crash", async () => {
    currentState.sources.set("src-1", { ...makeSourceRow("src-1"), provider: "lever" });
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed");
    expect(fetchBoardImpl).not.toHaveBeenCalled();
  });

  it("uncaught error mid-pipeline: retries via message.retry() below MAX_RETRY_ATTEMPTS", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => {
      throw new Error("boom: unexpected normalize failure");
    });
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(retried).toEqual([true]);
    expect(acked).toEqual([]);
  });

  it("programmer bug mid-pipeline (TypeError): fails fast, does NOT retry (code-review P1 fix)", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => {
      // Simulates a typo/undefined-is-not-a-function class of bug, as
      // opposed to the plain Error above which represents a genuinely
      // transient failure (network blip, D1 hiccup) that's still worth
      // retrying. Before the fix, both were retried identically up to
      // MAX_RETRY_ATTEMPTS times, hammering the ATS endpoint 5x for a
      // bug that retrying can never fix.
      throw new TypeError("undefined is not a function");
    });
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1, // well below MAX_RETRY_ATTEMPTS -- must still not retry
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(retried).toEqual([]); // the key assertion: no retry for a programmer error
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed_final");
    expect(currentState.sourceRuns.get("run-1")?.error_code).toBe("programmer_error");
  });

  it("invalid provider string in the DB row: config error, not a crash or an unchecked cast (code-review P2 fix)", async () => {
    currentState.sources.set("src-1", { ...makeSourceRow("src-1"), provider: "not-a-real-provider" });
    const { message, acked, retried } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    expect(retried).toEqual([]);
    expect(currentState.sourceRuns.get("run-1")?.status).toBe("failed");
    expect(fetchBoardImpl).not.toHaveBeenCalled();
  });
});

describe("handleIngestMessage - H.4 company-level signal generation (spec 7.1)", () => {
  it("hiring_burst: 3 new jobs for the same (company, role) in one run triggers a hiring_burst signal", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => [
      makeNormalizedJob("job-ext-1"),
      makeNormalizedJob("job-ext-2"),
      makeNormalizedJob("job-ext-3"),
    ]);
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    const signalTypes = [...currentState.signalsById.values()].map((s) => s.signal_type);
    // new_job fires once per distinct job (each is its own external_job_id,
    // so each is independently a "new_job" candidate); hiring_burst is a
    // company-level signal, deduped once findActiveSignal matches on the
    // 3rd job's stats crossing the >=3 threshold.
    expect(signalTypes).toContain("new_job");
    expect(signalTypes).toContain("hiring_burst");
    expect(signalTypes.filter((t) => t === "hiring_burst")).toHaveLength(1);
  });

  it("multi_location: 3 distinct location_modes for the same (company, role) triggers a multi_location signal", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => [
      { ...makeNormalizedJob("job-ext-1"), locationMode: "remote" as const },
      { ...makeNormalizedJob("job-ext-2"), locationMode: "hybrid" as const },
      { ...makeNormalizedJob("job-ext-3"), locationMode: "onsite" as const },
    ]);
    const { message, acked } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    expect(acked).toEqual([true]);
    const signalTypes = [...currentState.signalsById.values()].map((s) => s.signal_type);
    expect(signalTypes).toContain("multi_location");
    expect(signalTypes.filter((t) => t === "multi_location")).toHaveLength(1);
  });

  it("role_acceleration: does NOT trigger on a single job's cold-start acceleration value (regression: false-positive fix)", async () => {
    // computeAcceleration(1, 0) = (1-0)/max(2,0) = 0.5 exactly -- below
    // ROLE_ACCELERATION_MIN_COMPONENT (0.75), so a lone new job must not
    // spuriously read as "accelerating." This is the exact bug caught
    // and fixed during H.4 implementation (threshold raised 0.5 -> 0.75).
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-1")]);
    const { message } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    const signalTypes = [...currentState.signalsById.values()].map((s) => s.signal_type);
    expect(signalTypes).not.toContain("role_acceleration");
    expect(currentState.signalsById.size).toBe(1); // only the primary new_job signal
  });

  it("role_acceleration: 2 new jobs for the same (company, role) in one run saturates acceleration to 1.0 and triggers", async () => {
    // computeAcceleration(2, 0) = (2-0)/max(2,0) = 1.0 -- clears the 0.75
    // threshold. Verifies the trigger path actually fires, not just that
    // it correctly stays silent (previous test).
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-1"), makeNormalizedJob("job-ext-2")]);
    const { message } = makeMessage({
      version: 1,
      sourceId: "src-1",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      attempt: 1,
    });
    const { env } = makeFakeEnv();

    await handleIngestMessage(message, env);

    const signalTypes = [...currentState.signalsById.values()].map((s) => s.signal_type);
    expect(signalTypes).toContain("role_acceleration");
  });

  it("persistent_demand: an active new_job signal continuously active >=30 days triggers persistent_demand on the next detection", async () => {
    currentState.sources.set("src-1", makeSourceRow("src-1"));
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-1")]);

    // Run 1: creates the primary new_job signal, first_detected_at = now.
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-1",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );
    const primarySignal = [...currentState.signalsById.values()].find((s) => s.signal_type === "new_job")!;
    expect(primarySignal).toBeDefined();

    // Backdate first_detected_at by 31 days to simulate the signal having
    // stayed continuously active -- daysBetween(observedAt, first_detected_at)
    // must clear PERSISTENT_DEMAND_MIN_DAYS_ACTIVE (30) on the next run.
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    primarySignal.first_detected_at = thirtyOneDaysAgo;
    primarySignal.last_detected_at = thirtyOneDaysAgo;

    // Run 2: a content edit on the same job re-enters processNormalizedJob's
    // classification/signal path only if it's still a new_job/reopened_job
    // lifecycle candidate -- re-use a genuinely new external job id instead
    // so the lifecycle candidateSignal is "new_job" again, keeping this test
    // focused on the persistent_demand threshold rather than lifecycle edge
    // cases already covered elsewhere.
    normalizeImpl = vi.fn(() => [makeNormalizedJob("job-ext-2")]);
    await handleIngestMessage(
      makeMessage({
        version: 1,
        sourceId: "src-1",
        runId: "run-2",
        requestedAt: new Date().toISOString(),
        attempt: 1,
      }).message,
      makeFakeEnv().env,
    );

    const signalTypes = [...currentState.signalsById.values()].map((s) => s.signal_type);
    expect(signalTypes).toContain("persistent_demand");
  });
});
