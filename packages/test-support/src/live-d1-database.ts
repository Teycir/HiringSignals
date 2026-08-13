/**
 * A real `D1Database` (the raw Cloudflare Workers binding type, as
 * `@cloudflare/workers-types` declares it -- `prepare().bind().first/
 * all/run()`, plus `batch()`) implementation backed by the live, remote
 * `hiring-signals` D1 database, built on the same `./d1-remote-transport.ts`
 * `wrangler d1 execute --remote --json` transport `createLiveD1Client`
 * (`./live-d1-client.ts`) uses.
 *
 * Why this exists alongside `createLiveD1Client`: `packages/db`'s repo
 * functions (`createCompany`, `listSignals`, etc.) take a `D1Client`
 * (`lib/d1/client.ts`'s own thin interface) as their first argument, and
 * tests call them directly -- `createLiveD1Client()` covers that case.
 * But `apps/api/src/jobs/*.ts`'s handlers (`handleScheduled`,
 * `handleReconciliation`, `handleIngestMessage`) don't take a `D1Client`
 * at all -- they take `Bindings["DB"]` (a `D1Database`) via `env.DB` and
 * call `createD1Client(env.DB)` *themselves*, internally, exactly once
 * per invocation (see e.g. `apps/api/src/jobs/scheduler.ts`). A test of
 * one of those handlers has no seam to inject a `D1Client` at -- the
 * only injectable value is `env.DB` itself, which must be shaped like a
 * real `D1Database` for `createD1Client`'s own `db.prepare(sql).bind(...)
 * .first()/.all()/.run()` calls (`lib/d1/client.ts`) to work unmodified.
 * This file is that missing shape, so `apps/api/test/jobs/*.test.ts` can
 * pass a real `env.DB` into the real, un-mocked handler and let
 * `createD1Client` run exactly as it does in production -- per AGENTS.md's
 * "zero mocks, zero fakes" policy, which explicitly calls out `D1Database`
 * as one of the four resource types (`D1Database`, `Ai`, `VectorizeIndex`,
 * any KV namespace) that must never get an in-memory stand-in.
 *
 * There is no way to construct a live `D1Database` binding outside a
 * deployed Worker (same constraint `infrastructure/scripts/lib/
 * d1-exec.mjs` and `live-d1-client.ts` document) and this repo's `CF_TOKEN`
 * is deliberately scoped to Workers AI + Vectorize only (see
 * `live-cf-bindings.ts`'s header), not D1's direct HTTP query API --
 * confirmed live (2026-07-31): a direct `POST .../d1/database/.../query`
 * call with this token returns Cloudflare error 7403 ("account not
 * authorized"). So, same as `createLiveD1Client`, every method here
 * shells out to `wrangler d1 execute hiring-signals --remote --json`
 * rather than calling Cloudflare's REST API directly.
 *
 * `D1PreparedStatement.bind()` returns a *new* statement carrying the
 * bound values (per its real signature, `bind(...values): D1PreparedStatement`)
 * rather than mutating in place -- this implementation mirrors that:
 * `prepare(sql)` returns a statement with an empty params array baked
 * in, and `.bind(...values)` returns a fresh statement object with those
 * values attached, so two `.bind()` calls against the same prepared
 * statement (unusual, but not disallowed by the type) don't share state.
 *
 * `raw()` (D1PreparedStatement's fourth method) is intentionally NOT
 * implemented -- `lib/d1/client.ts`'s `createD1Client` never calls it,
 * and no `apps/api/src/jobs/*.ts` handler reaches `env.DB` any other
 * way than through `createD1Client`, so there is no real caller for it
 * in this test scope. Calling it throws a clear "not implemented" error
 * rather than silently returning an empty/wrong shape.
 *
 * Node-version note: `wrangler` requires >=22 -- run under `nvm use
 * 24.18.0` (this repo's own `package.json` `engines`), same as every
 * other `wrangler d1 execute` caller in this repo.
 */
import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from "@cloudflare/workers-types";
import { execRemote, inlineParams } from "./d1-remote-transport";

/**
 * Module-private symbol keys used to smuggle each statement's own
 * sql/boundParams out to `batch()` below, without adding them to the
 * public `D1PreparedStatement` surface (bind/first/run/all/raw is the
 * real type's full public contract -- adding a getter would make this
 * shape diverge from it). Symbols, not string properties, so nothing
 * outside this module can accidentally collide with or depend on these
 * -- `batch()` is the only intended reader, in the same file.
 */
const STMT_SQL = Symbol("sql");
const STMT_PARAMS = Symbol("boundParams");

interface StatementInternals {
  [STMT_SQL]: string;
  [STMT_PARAMS]: unknown[];
}

function makeStatement(sql: string, boundParams: unknown[]): D1PreparedStatement {
  const statement: Pick<D1PreparedStatement, "bind" | "first" | "run" | "all" | "raw"> & StatementInternals = {
    [STMT_SQL]: sql,
    [STMT_PARAMS]: boundParams,

    bind(...values: unknown[]): D1PreparedStatement {
      // A fresh statement, not a mutation -- matches the real
      // D1PreparedStatement contract (see this file's header comment).
      return makeStatement(sql, values);
    },

    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const inlined = inlineParams(sql, boundParams);
      const [result] = await execRemote(inlined);
      const rows = (result?.results ?? []) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      if (colName !== undefined) return (row[colName] as T) ?? null;
      return row as T;
    },

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const inlined = inlineParams(sql, boundParams);
      const [result] = await execRemote(inlined);
      return {
        success: result?.success ?? true,
        results: (result?.results ?? []) as T[],
        meta: {
          changes: result?.meta?.changes ?? 0,
          // Fields D1Result["meta"] declares but this transport's
          // wrangler --json output doesn't surface -- zeroed rather
          // than omitted, since lib/d1/client.ts's createD1Client only
          // ever reads `.meta?.changes` (confirmed by that file's own
          // `run()` implementation), so these are dead weight for every
          // real caller in this test scope, present only to satisfy the
          // D1Result type.
          duration: 0,
          last_row_id: 0,
          changed_db: (result?.meta?.changes ?? 0) > 0,
          size_after: 0,
          rows_read: 0,
          rows_written: result?.meta?.changes ?? 0,
        },
      } as D1Result<T>;
    },

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const inlined = inlineParams(sql, boundParams);
      const [result] = await execRemote(inlined);
      return {
        success: result?.success ?? true,
        results: (result?.results ?? []) as T[],
        meta: {
          changes: result?.meta?.changes ?? 0,
          duration: 0,
          last_row_id: 0,
          changed_db: false,
          size_after: 0,
          rows_read: (result?.results ?? []).length,
          rows_written: 0,
        },
      } as D1Result<T>;
    },

    raw(): never {
      throw new Error(
        "createLiveD1Database: D1PreparedStatement.raw() is not implemented -- " +
          "no real caller in this test scope reaches it (createD1Client in " +
          "lib/d1/client.ts only calls first/all/run/batch). If a new caller " +
          "needs it, implement it against the same wrangler --json transport " +
          "this file already uses for first/all/run.",
      );
    },
  };
  return statement as D1PreparedStatement;
}

/**
 * Creates a real `D1Database` backed by the live, remote `hiring-signals`
 * database. Pass this as `env.DB` into a real, un-mocked
 * `apps/api/src/jobs/*.ts` handler -- `createD1Client(env.DB)` inside
 * that handler will call `.prepare().bind().first/all/run()` on the
 * object this function returns exactly as it would against a real
 * Worker's binding, and every query runs for real against Cloudflare.
 */
export function createLiveD1Database(): D1Database {
  const db: Pick<D1Database, "prepare" | "batch" | "exec" | "withSession" | "dump"> = {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query, []);
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // 2026-08-12 perf fix (was: one .run() per statement, i.e. one
      // wrangler subprocess per statement). Each `wrangler d1 execute`
      // invocation costs ~6.5s of fixed CLI-startup overhead (measured:
      // user-time-dominated, not network -- a 2-statement SELECT pair
      // costs the same ~6.2s wall time as a single statement), so a
      // 2-statement batch previously cost ~13s instead of ~6.5s, and
      // every extra batched statement was free money left on the table.
      // apps/api/src/jobs/ingest-consumer.ts's processNormalizedJob
      // (ROADMAP.md J.4) calls client.batch([upsertStatement,
      // lifecycleStatement]) once per job -- with a 150-job chunk (G.3
      // chunking's own JOBS_PER_CHUNK), the old per-statement-.run()
      // behavior alone was worth ~150 * 6.5s = ~16min of pure,
      // eliminable overhead. Real fix: reach each statement's own
      // sql/boundParams via the STMT_SQL/STMT_PARAMS symbols above
      // (same object makeStatement built, just read internally instead
      // of through the public bind/first/run/all/raw surface), inline
      // params exactly as run()/first()/all() already do, join every
      // statement into one `;`-separated --command string, and issue
      // ONE execRemote call for the whole batch -- confirmed live
      // (2026-08-12) that `wrangler d1 execute --json` with a
      // `;`-joined multi-statement --command returns one JSON result
      // object per statement, in statement order, as
      // WranglerStatementResult[] -- exactly the shape this function
      // already destructures per-statement below.
      //
      // D1's real batch() contract is atomic (all-or-nothing in one
      // transaction) -- a single joined --command string is exactly
      // that: one SQLite connection, one implicit transaction for the
      // whole multi-statement script, so this preserves atomicity
      // rather than trading it away for speed (unlike the sequential
      // per-statement .run() loop this replaces, which was NOT atomic:
      // a mid-batch wrangler failure could leave only the first N
      // statements committed).
      if (statements.length === 0) return [];
      const internals = statements as unknown as StatementInternals[];
      const inlinedStatements = internals.map((stmt) => inlineParams(stmt[STMT_SQL], stmt[STMT_PARAMS]));
      const joined = inlinedStatements.join(";\n");
      const results = await execRemote(joined);
      if (results.length !== statements.length) {
        throw new Error(
          `createLiveD1Database.batch(): sent ${statements.length} statement(s) but wrangler returned ` +
            `${results.length} result(s) -- one of the joined statements likely produced zero or multiple ` +
            `result sets (e.g. a statement containing its own internal ';'). Joined SQL: ${joined}`,
        );
      }
      return results.map((result) => ({
        success: result?.success ?? true,
        results: (result?.results ?? []) as T[],
        meta: {
          changes: result?.meta?.changes ?? 0,
          duration: 0,
          last_row_id: 0,
          changed_db: (result?.meta?.changes ?? 0) > 0,
          size_after: 0,
          rows_read: 0,
          rows_written: result?.meta?.changes ?? 0,
        },
      })) as D1Result<T>[];
    },

    async exec(): Promise<D1ExecResult> {
      throw new Error(
        "createLiveD1Database: D1Database.exec() is not implemented -- no real " +
          "caller in this test scope reaches it.",
      );
    },

    withSession(): never {
      throw new Error(
        "createLiveD1Database: D1Database.withSession() is not implemented -- no " +
          "real caller in this test scope reaches it.",
      );
    },

    async dump(): Promise<ArrayBuffer> {
      throw new Error(
        "createLiveD1Database: D1Database.dump() is not implemented (deprecated " +
          "on the real D1Database too) -- no real caller in this test scope reaches it.",
      );
    },
  };
  return db as D1Database;
}
