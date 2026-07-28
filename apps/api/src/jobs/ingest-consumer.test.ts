import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Message } from "@cloudflare/workers-types";
import type { IngestMessage } from "@hiring-signals/domain";
import type { Bindings } from "../bindings";

/**
 * Purpose-built in-memory D1 fake for the ingest-consumer's end-to-end
 * pipeline test. Routes each query by matching on distinctive substrings
 * in the SQL text (same "assert on shape, not a real engine" spirit as
 * packages/db/src/signals-write-repo.test.ts) rather than parsing SQL
 * generically -- a hand-parsed SQL engine would be its own source of
 * bugs and could mask real regressions behind fake-parser bugs. Each
 * repo function's own exact SQL/param shape is independently covered by
 * packages/db's unit tests; this fake only needs to reproduce the
 * specific relational behaviors the consumer's idempotency contract
 * depends on: (1) jobs upsert-by-(source_id, external_job_id), (2)
 * job_observations' UNIQUE(job_id, source_run_id) constraint, (3)
 * source_runs keyed by id.
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
