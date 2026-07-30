/**
 * A real `D1Client` (packages/db's own interface, `lib/d1/client.ts`)
 * implementation backed by the live, remote `hiring-signals` D1
 * database -- per AGENTS.md's "zero mocks, zero fakes" testing policy.
 * No in-memory stand-in: every call here is a real network round trip
 * to Cloudflare, via `wrangler d1 execute hiring-signals --remote --json`,
 * the same mechanism `infrastructure/scripts/lib/d1-exec.mjs` already
 * uses for the ops scripts (there is no way to construct a live
 * `D1Database` binding outside a deployed Worker -- confirmed by that
 * file's own header comment, same constraint applies here).
 *
 * `wrangler d1 execute --command` has no bound-parameter flag (confirmed
 * via `wrangler d1 execute --help`, 2026-07-30 -- only `--command`/
 * `--file`, no parameter-binding option), so this client inlines values
 * into the SQL text itself rather than using D1's native `.bind()`
 * placeholders the way the real request-path `createD1Client`
 * (lib/d1/client.ts) does. This is safe here specifically because every
 * caller is test code supplying literal, test-authored values (UUIDs,
 * enum strings, small integers) -- never end-user input -- and every
 * value still goes through `escapeSqlValue` below (reusing the same
 * quote-escaping discipline `infrastructure/scripts/lib/d1-exec.mjs`'s
 * `sqlString` already established for the ops scripts) rather than raw
 * string concatenation. This is a test-only client; the production
 * `D1Client` (lib/d1/client.ts, used by every real route) is untouched
 * and still binds parameters properly.
 *
 * Node-version note: `wrangler` requires >=22 (confirmed by
 * `infrastructure/scripts/` ops-script sessions and this file's own
 * verification) -- run under `nvm use 24.18.0` (this repo's own
 * `package.json` `engines`), same as every other `wrangler d1 execute`
 * caller in this repo.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { D1Client } from "@hiring-signals/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/api/test/lib -> apps/api (where wrangler.toml's D1 binding lives,
// same cwd requirement infrastructure/scripts/lib/d1-exec.mjs documents).
const API_DIR = path.resolve(__dirname, "../..");

/** Escapes one JS value into a SQL literal for inline substitution into
 * a `--command` string. Mirrors infrastructure/scripts/lib/d1-exec.mjs's
 * `sqlString`, extended to numbers/booleans/null so this client can
 * serve arbitrary repo-function params, not just the string-only case
 * the ops scripts needed. */
function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot inline non-finite number into SQL: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Substitutes `?` placeholders in `sql` with escaped `params`, in order
 * -- the same positional-`?` convention every packages/db repo function
 * already writes its SQL against, so real repo functions can run
 * unmodified through this client. */
function inlineParams(sql: string, params: unknown[]): string {
  let i = 0;
  const inlined = sql.replace(/\?/g, () => {
    if (i >= params.length) {
      throw new Error(`SQL has more '?' placeholders than params provided (${params.length}): ${sql}`);
    }
    return escapeSqlValue(params[i++]);
  });
  if (i !== params.length) {
    throw new Error(`SQL used ${i} of ${params.length} provided params: ${sql}`);
  }
  return inlined;
}

interface WranglerStatementResult {
  results?: unknown[];
  success?: boolean;
  meta?: { changes?: number };
}

/** Runs one or more `;`-joined SQL statements against the real, live,
 * remote `hiring-signals` D1 database via `wrangler d1 execute --remote
 * --json`. Rejects with the real wrangler stderr/stdout on failure --
 * no swallowed errors, since a live-network test needs the real error
 * text to debug (auth failure, SQL error, rate limit, etc.). */
function execRemote(sql: string): Promise<WranglerStatementResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["wrangler", "d1", "execute", "hiring-signals", "--remote", "--json", "--command", sql],
      { cwd: API_DIR, shell: false },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn wrangler: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler d1 execute --remote failed (exit ${code}):\n${stderr || stdout}\nSQL: ${sql}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WranglerStatementResult[]);
      } catch (err) {
        reject(
          new Error(
            `Could not parse wrangler --json output: ${err instanceof Error ? err.message : String(err)}\nRaw stdout: ${stdout}`,
          ),
        );
      }
    });
  });
}

/**
 * Creates a real D1Client backed by the live remote database. Every
 * packages/db repo function called through this client (listSignals,
 * findSignalsByJobIds, toListItem's callers, etc.) runs its real
 * implementation, real SQL, against real Cloudflare infrastructure --
 * this file only stands in for the transport (D1Database binding),
 * per AGENTS.md's policy on what a test may and may not fake.
 */
export function createLiveD1Client(): D1Client {
  return {
    async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const inlined = inlineParams(sql, params);
      const [result] = await execRemote(inlined);
      const rows = (result?.results ?? []) as T[];
      return rows[0] ?? null;
    },

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const inlined = inlineParams(sql, params);
      const [result] = await execRemote(inlined);
      return (result?.results ?? []) as T[];
    },

    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const inlined = inlineParams(sql, params);
      const [result] = await execRemote(inlined);
      return { changes: result?.meta?.changes ?? 0 };
    },

    async batch<T>(statements: Array<{ sql: string; params?: unknown[] }>): Promise<T[][]> {
      // wrangler's --command supports multiple ';'-separated statements
      // in one invocation, returning one result object per statement --
      // matches D1Database's own batch() semantics closely enough for
      // test use (each statement still runs against the same live DB).
      const joined = statements.map(({ sql, params = [] }) => inlineParams(sql, params)).join(";\n");
      const results = await execRemote(joined);
      return results.map((r) => (r.results ?? []) as T[]);
    },
  };
}
