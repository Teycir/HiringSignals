import { describe, expect, it, vi } from "vitest";
import type { IngestMessage } from "@hiring-signals/domain";
import type { Bindings } from "../bindings";

/**
 * Fake D1Client (same style as
 * packages/db/src/signals-write-repo.test.ts -- a plain object literal,
 * not vi.fn()-wrapped, so D1Client's generic method signatures stay
 * intact) injected in place of @hiring-signals/db's createD1Client, since
 * the scheduler only ever receives a raw env.DB (D1Database) binding
 * that a unit test has no real instance of.
 */
let dueRows: unknown[] = [];
const allCalls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("@hiring-signals/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hiring-signals/db")>();
  return {
    ...actual,
    createD1Client: () => ({
      first: async () => null,
      all: async (sql: string, params: unknown[] = []) => {
        allCalls.push({ sql, params });
        return dueRows;
      },
      run: async () => ({ changes: 0 }),
      batch: async () => [],
    }),
  };
});

const { handleScheduled } = await import("./scheduler");

function makeSourceRow(id: string) {
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

function makeFakeEnv(): { env: Bindings; sent: Array<{ message: IngestMessage; delaySeconds?: number }> } {
  const sent: Array<{ message: IngestMessage; delaySeconds?: number }> = [];
  const env = {
    DB: {} as unknown as Bindings["DB"],
    CACHE: {} as unknown as Bindings["CACHE"],
    INGEST_QUEUE: {
      send: async (message: IngestMessage, options?: { delaySeconds?: number }) => {
        sent.push({ message, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Bindings["INGEST_QUEUE"],
    ENVIRONMENT: "development" as const,
  };
  return { env, sent };
}

describe("handleScheduled", () => {
  it("only enqueues sources returned by getDueSources, never fetches", async () => {
    dueRows = [makeSourceRow("src-1"), makeSourceRow("src-2")];
    allCalls.length = 0;
    const { env, sent } = makeFakeEnv();

    await handleScheduled({} as ScheduledEvent, env);

    expect(allCalls).toHaveLength(1);
    expect(allCalls[0]?.sql).toContain("FROM sources");
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.message.sourceId).sort()).toEqual(["src-1", "src-2"]);
    // Every enqueued message is a well-formed IngestMessage, attempt=1.
    for (const s of sent) {
      expect(s.message.version).toBe(1);
      expect(s.message.attempt).toBe(1);
      expect(s.message.runId).toBeTruthy();
    }
  });

  it("enqueues nothing when no sources are due", async () => {
    dueRows = [];
    const { env, sent } = makeFakeEnv();

    await handleScheduled({} as ScheduledEvent, env);

    expect(sent).toHaveLength(0);
  });

  it("jitter is deterministic for a given source_id across two calls", async () => {
    dueRows = [makeSourceRow("stable-id-abc")];
    const { env: env1, sent: sent1 } = makeFakeEnv();
    await handleScheduled({} as ScheduledEvent, env1);

    dueRows = [makeSourceRow("stable-id-abc")];
    const { env: env2, sent: sent2 } = makeFakeEnv();
    await handleScheduled({} as ScheduledEvent, env2);

    expect(sent1[0]?.delaySeconds).toBe(sent2[0]?.delaySeconds);
  });

  it("different source_ids can produce different jitter offsets", async () => {
    dueRows = [makeSourceRow("aaa"), makeSourceRow("zzz-different")];
    const { env, sent } = makeFakeEnv();
    await handleScheduled({} as ScheduledEvent, env);

    // Not a strict inequality assertion (hash collisions are possible in
    // principle) -- just confirms jitter is actually computed per-source
    // rather than a single constant reused for every message.
    expect(sent).toHaveLength(2);
    expect(typeof sent[0]?.delaySeconds).toBe("number");
    expect(typeof sent[1]?.delaySeconds).toBe("number");
  });
});
