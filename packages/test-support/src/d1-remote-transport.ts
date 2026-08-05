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
import { existsSync, readFileSync } from "node:fs";
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

function getCloudflareApiToken(): string | undefined {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (process.env.CF_TOKEN) return process.env.CF_TOKEN;
  const envLocalPath = path.join(REPO_ROOT, ".env.local");
  if (existsSync(envLocalPath)) {
    try {
      const content = readFileSync(envLocalPath, "utf-8");
      const cfMatch = content.match(/^(?:CF_TOKEN|CLOUDFLARE_API_TOKEN)=(.+)$/m);
      if (cfMatch?.[1]) {
        return cfMatch[1].trim();
      }
    } catch (err) {
      console.warn(`[d1-remote-transport] Failed to read .env.local: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

/** One raw `wrangler d1 execute --remote --json` invocation, no retry.
 * Rejects with the real wrangler stderr/stdout on failure -- no
 * swallowed errors, since a live-network test needs the real error text
 * to debug (auth failure, SQL error, rate limit, etc.). Extracted from
 * execRemote (2026-08-05) so the retry wrapper below can reuse this
 * single-attempt logic without duplicating the process-wiring. */
function execRemoteOnce(sql: string): Promise<WranglerStatementResult[]> {
  return new Promise((resolve, reject) => {
    const token = getCloudflareApiToken();
    const env = {
      ...process.env,
      PATH: resolveWranglerCompatiblePath(),
      ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
    };
    const child = spawn(
      "npx",
      ["wrangler", "d1", "execute", "hiring-signals", "--remote", "--json", "--command", sql],
      { cwd: API_DIR, shell: false, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn wrangler: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const output = [stderr, stdout].filter(Boolean).join("\n");
        reject(new Error(`wrangler d1 execute --remote failed (exit ${code}):\n${output}\nSQL: ${sql}`));
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

/** Matches the specific transient-auth failure signatures observed live
 * (2026-08-05, full packages/db suite runs under both 15-way and 4-way
 * `poolOptions.forks` concurrency): Cloudflare API `code: 7403` ("The
 * given account is not valid or is not authorized to access this
 * service"), `code: 10000` ("Authentication error"), and wrangler's own
 * "Not logged in. Could not authenticate" message. All three were
 * reproduced, then individually re-run in isolation (no concurrent
 * wrangler subprocesses) and passed cleanly every time -- `wrangler
 * whoami` also confirmed the underlying OAuth token was valid and
 * correctly D1-scoped throughout, both immediately before and after
 * the failing runs. That combination (fails only under concurrent
 * subprocess load, passes alone, valid token throughout) is the
 * signature of contention on the shared
 * `~/.config/.wrangler/config/default.toml` token file / a transient
 * Cloudflare-side rate limit surfaced as an auth error, not a real,
 * standing permissions problem.
 *
 * Deliberately narrow: matches by the *specific* error codes/text seen,
 * not "any non-zero exit" or "any error mentioning auth" -- a genuine
 * SQL error (constraint violation, syntax error) or a real, standing
 * credential problem must still fail immediately, not get masked by
 * retries. If a new failure shape shows up later, it should be
 * diagnosed on its own terms (isolate + wrangler whoami, same as this
 * one was) before being added here, not assumed to belong to this same
 * class. */
function isTransientAuthFailure(message: string): boolean {
  return (
    message.includes("code: 7403") ||
    message.includes("code: 10000") ||
    message.includes("Not logged in")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one or more `;`-joined SQL statements against the real, live,
 * remote `hiring-signals` D1 database via `wrangler d1 execute --remote
 * --json`, retrying up to 2 extra times (3 attempts total) with
 * backoff (500ms, 1500ms) if and only if the failure matches
 * isTransientAuthFailure's known transient-auth signatures (2026-08-05
 * -- see that function's comment for the reproduced evidence this is
 * based on). Any other failure (SQL error, malformed --json output,
 * failed spawn) rejects immediately on the first attempt, unchanged
 * from before -- retrying an error we haven't confirmed is transient
 * would hide real bugs behind a delay instead of surfacing them. */
export async function execRemote(sql: string): Promise<WranglerStatementResult[]> {
  const delaysMs = [500, 1500];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await execRemoteOnce(sql);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = attempt === delaysMs.length;
      if (isLastAttempt || !isTransientAuthFailure(message)) {
        throw err;
      }
      await sleep(delaysMs[attempt]!);
    }
  }
  // Unreachable (the loop always returns or throws), but keeps the
  // function's return type honest without a non-null assertion at the
  // call site.
  throw lastError;
}
