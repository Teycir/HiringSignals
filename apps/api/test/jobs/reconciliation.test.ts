import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Bindings } from "../../src/bindings";
import type * as DbModule from "@hiring-signals/db";

const staleSignals: unknown[] = [];
const calls = {
  list: [] as unknown[],
  stats: [] as unknown[],
  update: [] as unknown[],
  evidence: [] as unknown[],
};
let nextUpdateChanges = 1;

vi.mock("@hiring-signals/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    createD1Client: () => ({}),
    listSignalsNeedingReconciliation: async (_client: unknown, params: unknown) => {
      calls.list.push(params);
      return staleSignals;
    },
    getCompanyRoleActivityStats: async (_client: unknown, params: unknown) => {
      calls.stats.push(params);
      return {
        activeMatchingCount: 1,
        newInLast14Days: 0,
        newInPrior56Days: 0,
        distinctLocationCount: 1,
      };
    },
    updateSignalScore: async (_client: unknown, signalId: string, input: unknown) => {
      calls.update.push({ signalId, input });
      return { changes: nextUpdateChanges };
    },
    appendSignalEvidence: async (_client: unknown, input: unknown) => {
      calls.evidence.push(input);
      return "ev-1";
    },
  };
});

const { handleReconciliation } = await import("../../src/jobs/reconciliation");

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

function makeFakeEnv(): Bindings {
  return {
    DB: unusedBinding<Bindings["DB"]>("DB"),
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    RAW_PAYLOADS: unusedBinding<Bindings["RAW_PAYLOADS"]>("RAW_PAYLOADS"),
    ABUSE_LOGS: unusedBinding<Bindings["ABUSE_LOGS"]>("ABUSE_LOGS"),
    INGEST_QUEUE: unusedBinding<Bindings["INGEST_QUEUE"]>("INGEST_QUEUE"),
    AI: unusedBinding<Bindings["AI"]>("AI"),
    VECTORIZE: unusedBinding<Bindings["VECTORIZE"]>("VECTORIZE"),
    ENVIRONMENT: "development",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
  };
}

beforeEach(() => {
  staleSignals.length = 0;
  calls.list.length = 0;
  calls.stats.length = 0;
  calls.update.length = 0;
  calls.evidence.length = 0;
  nextUpdateChanges = 1;
});

describe("handleReconciliation", () => {
  it("recomputes stale active signal scores and appends score_recomputed evidence without moving last_detected_at", async () => {
    staleSignals.push({
      id: "sig-stale",
      company_id: "co-1",
      role_category: "software_engineering",
      signal_type: "new_job",
      score: 90,
      score_version: "v2",
      first_detected_at: "2026-07-01T06:00:00.000Z",
      last_detected_at: "2026-07-01T06:00:00.000Z",
      classification_confidence: 0.9,
    });

    await handleReconciliation(makeFakeEnv(), new Date("2026-07-31T06:00:00.000Z"));

    expect(calls.list).toEqual([{ staleBefore: "2026-07-30T06:00:00.000Z", limit: 200 }]);
    expect(calls.stats).toEqual([
      {
        companyId: "co-1",
        roleCategory: "software_engineering",
        now: "2026-07-31T06:00:00.000Z",
      },
    ]);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ signalId: "sig-stale" });
    expect((calls.update[0] as { input: { score: number; scoreVersion: string } }).input.scoreVersion).toBe("v2");
    expect((calls.update[0] as { input: { score: number } }).input.score).toBeLessThan(90);
    expect(JSON.stringify(calls.update[0])).not.toContain("lastDetectedAt");

    expect(calls.evidence).toHaveLength(1);
    expect(calls.evidence[0]).toMatchObject({
      signalId: "sig-stale",
      jobId: null,
      evidenceType: "score_recomputed",
      observedAt: "2026-07-31T06:00:00.000Z",
    });
  });

  it("does nothing when no stale signals are returned", async () => {
    await handleReconciliation(makeFakeEnv(), new Date("2026-07-31T06:00:00.000Z"));

    expect(calls.list).toHaveLength(1);
    expect(calls.stats).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
    expect(calls.evidence).toHaveLength(0);
  });

  it("does not append recompute evidence when the score update races with an inactive signal", async () => {
    staleSignals.push({
      id: "sig-raced",
      company_id: "co-1",
      role_category: "software_engineering",
      signal_type: "new_job",
      score: 90,
      score_version: "v2",
      first_detected_at: "2026-07-01T06:00:00.000Z",
      last_detected_at: "2026-07-01T06:00:00.000Z",
      classification_confidence: 0.9,
    });
    nextUpdateChanges = 0;

    await handleReconciliation(makeFakeEnv(), new Date("2026-07-31T06:00:00.000Z"));

    expect(calls.update).toHaveLength(1);
    expect(calls.evidence).toHaveLength(0);
  });
});
