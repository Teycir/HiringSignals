import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Message } from "@cloudflare/workers-types";
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
  };
}

type FakeState = ReturnType<typeof createFakeState>;

function makeFakeClient(state: FakeState) {
  return {
    async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      if (sql.includes("FROM sources WHERE id")) {
        return (state.sources.get(params[0] as string) as T) ?? null;
      }
      if (sql.includes("SELECT id FROM jobs WHERE source_id")) {
        const key = `${params[0]}::${params[1]}`;
        const row = state.jobsByKey.get(key);
        return row ? ({ id: row.id } as T) : null;
      }
      if (sql.includes("SELECT id, status, missing_run_count, first_seen_at FROM jobs")) {
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

function makeFakeEnv(): { env: Bindings; sent: Array<{ message: IngestMessage; delaySeconds?: number }> } {
  const sent: Array<{ message: IngestMessage; delaySeconds?: number }> = [];
  const env = {
    DB: unusedBinding<Bindings["DB"]>("DB"),
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    INGEST_QUEUE: {
      send: async (message: IngestMessage, options?: { delaySeconds?: number }) => {
        sent.push({ message, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Bindings["INGEST_QUEUE"],
    ENVIRONMENT: "development" as const,
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
