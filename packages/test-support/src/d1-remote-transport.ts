/**
 * Shared transport for every live-D1-backed test helper in this package
 * (`createLiveD1Client`'s `D1Client` shape, `createLiveD1Database`'s
 * `D1Database` shape). Extracted from `live-d1-client.ts` (2026-07-31)
 * so both shapes run the exact same `wrangler d1 execute --remote
 * --json` transport, `?`-placeholder inlining, and SQL-literal escaping
 * instead of two copies drifting apart. See `live-d1-client.ts`'s
 * original header comment for the full "why wrangler CLI, not direct
 * REST" and "why inline params instead of native .bind()" reasoning --
 * both still apply unchanged; only the file location of this logic
 * moved.
 *
 * Node-version note: `wrangler` requires >=22 -- run under `nvm use
 * 24.18.0` (this repo's own `package.json` `engines`), same as every
 * other `wrangler d1 execute` caller in this repo.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `wrangler` requires Node >=22. Whatever `node`/`npx` resolves to on the
 * *caller's* PATH may be older (e.g. a global default of v20) regardless
 * of this repo's own `engines` field, since nothing enforces `nvm use`
 * before a plain `vitest run`. Rather than requiring every caller to
 * remember to switch first, prepend a known-good nvm-managed bin dir
 * (if present) to PATH for the spawned child only -- leaves the
 * caller's own process/shell untouched. Falls back to whatever's
 * already on PATH if no matching nvm install is found, so this is a
 * best-effort upgrade, not a hard requirement.
 */
function resolveWranglerCompatiblePath(): string {
  const nvmNodeDir = path.join(os.homedir(), ".nvm", "versions", "node");
  const preferred = ["v24.18.0", "v22.22.3"];
  for (const version of preferred) {
    const binDir = path.join(nvmNodeDir, version, "bin");
    if (existsSync(path.join(binDir, "node"))) {
      return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    }
  }
  return process.env.PATH ?? "";
}
// packages/test-support/src -> repo root -> apps/api (where
// wrangler.toml's D1 binding lives). Must resolve to apps/api regardless
// of which package's test imports this file -- there is exactly one
// wrangler.toml with this D1 binding in the repo.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const API_DIR = path.join(REPO_ROOT, "apps/api");

/** Escapes one JS value into a SQL literal for inline substitution into
 * a `--command` string. Mirrors infrastructure/scripts/lib/d1-exec.mjs's
 * `sqlString`, extended to numbers/booleans/null so this transport can
 * serve arbitrary repo-function params, not just the string-only case
 * the ops scripts needed. */
export function escapeSqlValue(value: unknown): string {
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
 * (and every apps/api/src/jobs/*.ts handler, via createD1Client) already
 * writes its SQL against, so real code runs unmodified through this
 * transport. */
export function inlineParams(sql: string, params: unknown[]): string {
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

export interface WranglerStatementResult {
  results?: unknown[];
  success?: boolean;
  meta?: { changes?: number };
}

/** Runs one or more `;`-joined SQL statements against the real, live,
 * remote `hiring-signals` D1 database via `wrangler d1 execute --remote
 * --json`. Rejects with the real wrangler stderr/stdout on failure --
 * no swallowed errors, since a live-network test needs the real error
 * text to debug (auth failure, SQL error, rate limit, etc.). */
export function execRemote(sql: string): Promise<WranglerStatementResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["wrangler", "d1", "execute", "hiring-signals", "--remote", "--json", "--command", sql],
      { cwd: API_DIR, shell: false, env: { ...process.env, PATH: resolveWranglerCompatiblePath() } },
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
