/**
 * Thin D1 client wrapper. Every query goes through `.bind()` with
 * placeholders -- callers never interpolate values into SQL text. Meant
 * to be the only place in a project that touches `D1Database` directly;
 * everything else calls these helpers instead of `env.DB.prepare(...)`.
 *
 * Every call is routed through a module-level circuit breaker
 * (../http/circuit-breaker.ts) on the "db" resource. This is the *only*
 * choke point every repo function goes through (packages/db/src/*-repo.ts
 * -> createD1Client(c.env.DB), one call per request, see apps/api/src/
 * routes/*.ts) -- wrapping here protects all of them with zero call-site
 * changes, instead of threading withCircuit through each repo function
 * individually. State lives in circuit-breaker.ts's module-level map,
 * which is fine because a Worker isolate handles one request at a time
 * (see that file's header comment).
 *
 * Depends on ../http/circuit-breaker.ts (zero project-specific deps
 * itself) -- copy both files together into any Cloudflare Workers + D1
 * project as-is.
 */

import { createCircuitBreaker } from "../http/circuit-breaker";

const breaker = createCircuitBreaker({ resources: ["db"] });

export interface D1Client {
  /** Zero-or-one row. */
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Zero-or-more rows. */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE. Returns rows affected. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /**
   * Multiple statements in one round trip -- D1's real atomicity
   * primitive (D1 has no BEGIN/COMMIT SQL surface via the Workers
   * binding). Runs as one SQL transaction: if ANY statement in the list
   * fails, the ENTIRE sequence is rolled back, not just that statement
   * (confirmed against Cloudflare's own D1 docs, 2026-08-02).
   *
   * That all-or-nothing rollback is exactly why batch() is safe for a
   * fixed set of writes that must all succeed together, and exactly why
   * it is UNSAFE to use for any statement whose caller relies on
   * catching that specific statement's own failure in isolation (e.g. a
   * UNIQUE-constraint violation used as an idempotent "already done,
   * continue" signal) -- batching such a statement alongside others
   * means a legitimate expected-failure retry now also discards every
   * sibling write in that batch. See apps/api/src/jobs/ingest-consumer.ts's
   * header comment for a concrete example of this trade-off in practice.
   *
   * batch() also cannot branch mid-sequence: every statement's SQL and
   * params must be decided before the call, so it cannot express "read
   * X, then decide whether to UPDATE or INSERT based on X" -- that shape
   * needs a plain read via first()/all() followed by a separate
   * decision, with only the resulting fixed writes (if independent of
   * each other) passed to batch().
   */
  batch<T>(statements: Array<{ sql: string; params?: unknown[] }>): Promise<T[][]>;
}

export interface CreateD1ClientOptions {
  /**
   * Per-call circuit-breaker timeout override for first()/all()/run().
   * Omit in production (falls through to the shared module-level
   * breaker's own 15s default) -- only test callers hitting real
   * per-call latency against a live remote D1 need this. Deliberately
   * NOT a second createCircuitBreaker(...) instantiation: that would
   * give the caller its own independent failure/circuit state instead
   * of sharing the resource's real one. See ../http/circuit-
   * breaker.ts's withCircuit doc comment and ROADMAP.md's J.2 entry
   * for why.
   */
  operationTimeoutMs?: number;
  /**
   * Per-call circuit-breaker timeout override for batch() specifically.
   * Falls back to operationTimeoutMs, then the breaker's 15s default,
   * when omitted. A separate knob because batch()'s multi-statement
   * wrangler --command transport is measurably slower than a single
   * first()/all()/run() call in this environment (31.7s for a 7-
   * statement batch(), isolated, no prior calls in the same test --
   * see ROADMAP.md's J.2 entry) -- one shared value has to either
   * over-cover every single-statement call to fit batch(), or
   * under-cover batch() to stay tight for single-statement calls.
   * This lets batch() get the room it needs without loosening the
   * breaker's timeout for the calls that don't.
   */
  batchOperationTimeoutMs?: number;
}

export function createD1Client(db: D1Database, options?: CreateD1ClientOptions): D1Client {
  const operationTimeoutMsOverride = options?.operationTimeoutMs;
  // batch()'s own override falls back to operationTimeoutMs, then the
  // breaker's 15s default -- see CreateD1ClientOptions.batchOperationTimeoutMs
  // doc comment for why this needs its own value instead of sharing
  // operationTimeoutMsOverride with first()/all()/run().
  const batchOperationTimeoutMsOverride =
    options?.batchOperationTimeoutMs ?? operationTimeoutMsOverride;

  return {
    first<T>(sql: string, params: unknown[] = []) {
      return breaker.withCircuit(
        "db",
        async () => {
          const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
          const row = await stmt.first<T>();
          return row ?? null;
        },
        operationTimeoutMsOverride,
      );
    },

    all<T>(sql: string, params: unknown[] = []) {
      return breaker.withCircuit(
        "db",
        async () => {
          const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
          const { results } = await stmt.all<T>();
          return results ?? [];
        },
        operationTimeoutMsOverride,
      );
    },

    run(sql: string, params: unknown[] = []) {
      return breaker.withCircuit(
        "db",
        async () => {
          const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
          const result = await stmt.run();
          return { changes: result.meta?.changes ?? 0 };
        },
        operationTimeoutMsOverride,
      );
    },

    batch<T>(statements: Array<{ sql: string; params?: unknown[] }>) {
      return breaker.withCircuit(
        "db",
        async () => {
          const prepared = statements.map(({ sql, params = [] }) =>
            params.length ? db.prepare(sql).bind(...params) : db.prepare(sql),
          );
          const results = await db.batch<T>(prepared);
          return results.map((r) => r.results ?? []);
        },
        batchOperationTimeoutMsOverride,
      );
    },
  };
}
