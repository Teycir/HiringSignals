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

/** Which physical D1 database every execRemote call targets. Defaults to
 * the real production `hiring-signals` database (unchanged behavior for
 * every existing local/manual call site) -- set D1_DATABASE_NAME to
 * override, e.g. "hiring-signals-ci" for the isolated CI database
 * (wrangler.toml's `[env.ci]` block, provisioned 2026-08-05). Read once
 * at module load rather than per-call: every caller in a given process
 * (a single CI job, a single local test run) targets one database for
 * the whole run, never a mix, so there is no case where a stale
 * module-load-time read would be wrong within one run. */
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME || "hiring-signals";
/** Which wrangler --env this database lives under, if any (e.g. "ci" for
 * hiring-signals-ci, which only exists under `[env.ci]`). Empty string
 * means no --env flag, matching wrangler's own default when a database
 * is declared at the top level. */
const D1_WRANGLER_ENV = process.env.D1_WRANGLER_ENV || "";

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

/**
 * Resolves a Cloudflare API token from, in order: `CLOUDFLARE_API_TOKEN`,
 * `CF_TOKEN` (either as an ambient env var, or as a `KEY=value` line in
 * `.env.local` at the repo root). Shared by every live-Cloudflare helper
 * in this package (`d1-remote-transport.ts`'s own callers below, and
 * `live-cf-bindings.ts`'s `loadCfToken` re-export) so there is exactly
 * one token-resolution implementation, not two independently-maintained
 * copies that can silently drift apart (test-support follow-up,
 * ROADMAP.md Milestone J -- `live-cf-bindings.ts`'s original
 * `loadCfToken` only ever matched a bare `^CF_TOKEN=` line and never
 * recognized `CLOUDFLARE_API_TOKEN` in `.env.local` at all, while this
 * file's version already handled both; unifying on this file's broader
 * version is strictly more permissive, not a behavior narrowing).
 *
 * `.env.local` parsing is intentionally simple (one regex line-match,
 * first match wins, `m` flag so it isn't anchored to the file start) --
 * not a general dotenv parser (no quoting, no escaping, no multi-line
 * values, no comment handling beyond "line doesn't match the pattern").
 * Sufficient for this repo's own `.env.local` (a small, hand-maintained
 * file, see that file's own header comment on its token's scope) --
 * swap in a real dotenv library here if `.env.local` ever needs more
 * than flat `KEY=value` lines.
 *
 * Read fresh on every call (not cached at module load) so a token
 * rotated mid-process -- e.g. `.env.local` edited between two test
 * files in the same `vitest run` -- is picked up without requiring a
 * process restart; the read itself is cheap (one small local file, or
 * skipped entirely when an env var is already set).
 */
export function resolveCfToken(): string | undefined {
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

/**
 * Same resolution as `resolveCfToken()`, but throws immediately with a
 * clear, actionable message when no token is found anywhere, instead of
 * returning `undefined` and letting a later network call fail with a
 * generic 401/403 stack trace (test-support follow-up, ROADMAP.md
 * Milestone J: `live-d1-client.ts`/`d1-remote-transport.ts` previously
 * had no credential preflight of their own, unlike
 * `live-cf-bindings.ts`'s explicit throwing `loadCfToken` -- this
 * closes that gap by giving the D1 transport the same upfront check,
 * rather than picking the opposite direction and silencing
 * `live-cf-bindings.ts`'s existing clear failure). `execRemoteOnce`
 * below calls this rather than `resolveCfToken()` directly so a missing
 * token fails fast, before ever spawning a `wrangler` subprocess.
 */
export function requireCfToken(): string {
  const token = resolveCfToken();
  if (!token) {
    throw new Error(
      "Missing Cloudflare API token: set CLOUDFLARE_API_TOKEN or CF_TOKEN in the " +
        "environment, or add a CF_TOKEN=... / CLOUDFLARE_API_TOKEN=... line to " +
        ".env.local at the repo root.",
    );
  }
  return token;
}

/**
 * Truncation length for SQL text included in thrown errors. Values in
 * this transport's SQL are always test-authored literals (see this
 * file's own header comment -- never end-user input), so there is
 * nothing here that needs redacting for a *sensitivity* reason; the
 * truncation is purely a debugging-usability limit (test-support
 * follow-up, ROADMAP.md Milestone J), since a large seed/batch
 * statement's full inlined text is unwieldy in a failed-test log and
 * the first ~500 chars is normally enough to identify which statement
 * failed. Full, untruncated SQL is always still visible by re-running
 * the failing call in isolation with a debugger/log statement -- this
 * limit only affects the thrown error's own message. */
const SQL_ERROR_PREVIEW_CHARS = 500;

function previewSql(sql: string): string {
  return sql.length > SQL_ERROR_PREVIEW_CHARS
    ? `${sql.slice(0, SQL_ERROR_PREVIEW_CHARS)}… (${sql.length - SQL_ERROR_PREVIEW_CHARS} more chars truncated)`
    : sql;
}

/** One raw `wrangler d1 execute --remote --json` invocation, no retry.
 * Rejects with the real wrangler stderr/stdout on failure -- no
 * swallowed errors, since a live-network test needs the real error text
 * to debug (auth failure, SQL error, rate limit, etc.). Extracted from
 * execRemote (2026-08-05) so the retry wrapper below can reuse this
 * single-attempt logic without duplicating the process-wiring. */
function execRemoteOnce(sql: string): Promise<WranglerStatementResult[]> {
  return new Promise((resolve, reject) => {
    // Fails fast, before spawning anything, on a missing token --
    // credential-preflight parity with live-cf-bindings.ts's
    // loadCfToken (test-support follow-up, ROADMAP.md Milestone J).
    let token: string;
    try {
      token = requireCfToken();
    } catch (err) {
      reject(err);
      return;
    }
    const env = {
      ...process.env,
      PATH: resolveWranglerCompatiblePath(),
      CLOUDFLARE_API_TOKEN: token,
    };
    const args = ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--json", "--command", sql];
    if (D1_WRANGLER_ENV) args.push("--env", D1_WRANGLER_ENV);
    const child = spawn("npx", args, { cwd: API_DIR, shell: false, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Failed to spawn wrangler: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const output = [stderr, stdout].filter(Boolean).join("\n");
        reject(
          new Error(`wrangler d1 execute --remote failed (exit ${code}):\n${output}\nSQL: ${previewSql(sql)}`),
        );
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
