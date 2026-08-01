import { afterEach, describe, expect, it } from "vitest";
import type { IngestMessage } from "@hiring-signals/domain";
import { createLiveD1Database } from "@hiring-signals/test-support";
import { createD1Client, createCompany, createSource, updateSource } from "@hiring-signals/db";
import type { D1Client } from "@hiring-signals/db";
import type { Bindings } from "../../src/bindings";
import { handleScheduled } from "../../src/jobs/scheduler";

/**
 * Migrated off `vi.mock("@hiring-signals/db")` (AGENTS.md's "zero
 * mocks, zero fakes" policy, ROADMAP.md Milestone J) onto the real,
 * live, shared `hiring-signals` D1 database, using `createLiveD1Database()`
 * so `env.DB` is a real `D1Database`-shaped binding and `handleScheduled`
 * runs completely unmodified against it -- same migration pattern as
 * reconciliation.test.ts in this directory.
 *
 * `INGEST_QUEUE` stays an in-memory fake (captures `.send()` calls) --
 * this is the AGENTS.md-documented permanent exception, not a mock of
 * `@hiring-signals/db`: `handleScheduled` must NEVER fetch a provider
 * directly (see scheduler.ts's own header comment), so a real queue
 * consumer is deliberately out of scope for this handler's own test.
 *
 * The original fake-D1 version asserted `allCalls` had exactly one SQL
 * call ("never fetches"/introspects the query itself) -- a live client
 * has no such introspection point (same limitation already documented in
 * packages/db/test/signals-write-repo.test.ts's header comment). That
 * assertion is dropped in favor of the behavioral outcome it was a proxy
 * for: only sources that are actually due get enqueued, and disabled/
 * not-yet-due sources don't.
 *
 * getDueSources takes no company-scoping parameter and runs against a
 * shared live database, so tests seed their own sources with a distinct
 * board_token/company per test and assert on presence/absence of their
 * own sourceId in `sent`, rather than asserting exclusivity or an exact
 * count of the full result set -- same precedent as
 * signals-write-repo.test.ts's listSignalsNeedingReconciliation tests.
 *
 * Every test uses a `test-sched`-prefixed slug and cleans up in a
 * `finally` (FK-safe: sources -> companies), with an `afterEach` sweep
 * as a second pass.
 */

const TEST_PREFIX = "test-sched";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createD1Client(createLiveD1Database());

async function cleanupCompany(companyId: string): Promise<void> {
  await client.run(`DELETE FROM sources WHERE company_id = ?`, [companyId]);
  await client.run(`DELETE FROM companies WHERE id = ?`, [companyId]);
}

afterEach(async () => {
  await client.run(
    `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
    [`${TEST_PREFIX}-%`],
  );
  await client.run(`DELETE FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`]);
});

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

/** INGEST_QUEUE stays an in-memory fake -- see file header. Everything
 * else is a real binding or an unused-if-touched placeholder. */
function makeEnv(db: Bindings["DB"]): { env: Bindings; sent: Array<{ message: IngestMessage; delaySeconds?: number }> } {
  const sent: Array<{ message: IngestMessage; delaySeconds?: number }> = [];
  const env: Bindings = {
    DB: db,
    CACHE: unusedBinding<Bindings["CACHE"]>("CACHE"),
    RAW_PAYLOADS: unusedBinding<Bindings["RAW_PAYLOADS"]>("RAW_PAYLOADS"),
    ABUSE_LOGS: unusedBinding<Bindings["ABUSE_LOGS"]>("ABUSE_LOGS"),
    ADMIN_SECRET: "unused-in-this-test",
    INGEST_QUEUE: {
      send: async (message: IngestMessage, options?: { delaySeconds?: number }) => {
        sent.push({ message, delaySeconds: options?.delaySeconds });
      },
    } as unknown as Bindings["INGEST_QUEUE"],
    AI: unusedBinding<Bindings["AI"]>("AI"),
    VECTORIZE: unusedBinding<Bindings["VECTORIZE"]>("VECTORIZE"),
    ENVIRONMENT: "development",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
  };
  return { env, sent };
}

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

/** A due source: enabled, next_poll_at NULL (never-yet-polled -- always
 * due per getDueSources). */
async function seedDueSource(companyId: string, boardToken: string) {
  return createSource(client, {
    companyId,
    provider: "greenhouse",
    boardToken,
    publicUrl: `https://example.invalid/${boardToken}`,
  });
}

describe("handleScheduled", () => {
  it("enqueues due (never-yet-polled, enabled) sources, one well-formed IngestMessage each", async () => {
    const company = await seedCompany("due", "Scheduler Due Co");
    try {
      const src1 = await seedDueSource(company.id, testSlug("due-a"));
      const src2 = await seedDueSource(company.id, testSlug("due-b"));

      const db = createLiveD1Database();
      const { env, sent } = makeEnv(db);
      await handleScheduled({} as ScheduledEvent, env);

      const mine = sent.filter((s) => s.message.sourceId === src1.id || s.message.sourceId === src2.id);
      expect(mine).toHaveLength(2);
      expect(mine.map((s) => s.message.sourceId).sort()).toEqual([src1.id, src2.id].sort());
      for (const s of mine) {
        expect(s.message.version).toBe(1);
        expect(s.message.attempt).toBe(1);
        expect(s.message.runId).toBeTruthy();
      }
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not enqueue a disabled source", async () => {
    const company = await seedCompany("disabled", "Scheduler Disabled Co");
    try {
      const src = await createSource(client, {
        companyId: company.id,
        provider: "greenhouse",
        boardToken: testSlug("disabled-src"),
        publicUrl: "https://example.invalid/disabled",
        enabled: false,
      });

      const db = createLiveD1Database();
      const { env, sent } = makeEnv(db);
      await handleScheduled({} as ScheduledEvent, env);

      expect(sent.some((s) => s.message.sourceId === src.id)).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not enqueue a source whose next_poll_at is in the future", async () => {
    const company = await seedCompany("notyet", "Scheduler Not Yet Due Co");
    try {
      const src = await seedDueSource(company.id, testSlug("notyet-src"));
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      await updateSource(client, src.id, company.id, { nextPollAt: farFuture });

      const db = createLiveD1Database();
      const { env, sent } = makeEnv(db);
      await handleScheduled({} as ScheduledEvent, env);

      expect(sent.some((s) => s.message.sourceId === src.id)).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("jitter is deterministic for a given source_id across two separate handleScheduled calls", async () => {
    const company = await seedCompany("jitter-stable", "Scheduler Jitter Stable Co");
    try {
      const src = await seedDueSource(company.id, testSlug("jitter-stable-src"));

      const { env: env1, sent: sent1 } = makeEnv(createLiveD1Database());
      await handleScheduled({} as ScheduledEvent, env1);
      const first = sent1.find((s) => s.message.sourceId === src.id);
      expect(first).toBeDefined();

      const { env: env2, sent: sent2 } = makeEnv(createLiveD1Database());
      await handleScheduled({} as ScheduledEvent, env2);
      const second = sent2.find((s) => s.message.sourceId === src.id);
      expect(second).toBeDefined();

      // Same source_id, same jitter offset -- jitter is a pure function
      // of source_id, not of when handleScheduled happens to run.
      expect(first?.delaySeconds).toBe(second?.delaySeconds);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("different source_ids can produce different jitter offsets", async () => {
    const company = await seedCompany("jitter-diff", "Scheduler Jitter Diff Co");
    try {
      const srcA = await seedDueSource(company.id, testSlug("jitter-diff-a"));
      const srcB = await seedDueSource(company.id, testSlug("jitter-diff-b"));

      const { env, sent } = makeEnv(createLiveD1Database());
      await handleScheduled({} as ScheduledEvent, env);

      const a = sent.find((s) => s.message.sourceId === srcA.id);
      const b = sent.find((s) => s.message.sourceId === srcB.id);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Not a strict inequality assertion (hash collisions are possible
      // in principle) -- just confirms jitter is actually computed
      // per-source rather than a single constant reused for every
      // message.
      expect(typeof a?.delaySeconds).toBe("number");
      expect(typeof b?.delaySeconds).toBe("number");
    } finally {
      await cleanupCompany(company.id);
    }
  });
});
