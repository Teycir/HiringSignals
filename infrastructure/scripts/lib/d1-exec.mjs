// Shared D1 access for the ops scripts (ROADMAP.md Milestone D, spec
// §13.5). These scripts run as plain Node processes outside the Workers
// runtime, so they cannot construct a real D1Database binding the way
// createD1Client() (lib/d1/client.ts) expects -- there is no live
// binding available outside `wrangler dev`/a deployed Worker. Instead,
// every query here shells out to `wrangler d1 execute --json`, which is
// wrangler's own supported way to run SQL against a local or remote D1
// database from a plain CLI context.
//
// This intentionally duplicates the *queries* used by packages/db/src/
// sources-repo.ts (not the D1Client abstraction itself, which can't be
// reused here) -- keep the SQL shape in sync with that file by hand if
// the schema changes; there's no way to import the actual repo functions
// into a wrangler-shell-based script.

import { spawn } from "node:child_process";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const API_DIR = `${REPO_ROOT}apps/api`;

/**
 * Runs one SQL statement via `wrangler d1 execute hiring-signals --json`
 * from apps/api (where wrangler.toml's D1 binding lives) and returns the
 * parsed result rows.
 *
 * @param {string} sql
 * @param {{ local?: boolean }} [opts] local defaults to true -- ops
 *   scripts should never touch the remote/production database by
 *   accident. Pass { local: false } explicitly (and expect a wrangler
 *   confirmation prompt) to run against remote.
 * @returns {Promise<any[]>} the `results` array from wrangler's --json output
 */
export function d1Execute(sql, opts = {}) {
  const local = opts.local ?? true;
  const args = [
    "wrangler",
    "d1",
    "execute",
    "hiring-signals",
    local ? "--local" : "--remote",
    "--json",
    "--command",
    sql,
  ];
  if (!local) args.push("-y"); // remote writes prompt for confirmation; scripts pass -y deliberately, never silently


  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: API_DIR, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler d1 execute failed (exit ${code}): ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // wrangler --json returns an array of one result object per
        // statement; a single --command with one statement is index 0.
        resolve(parsed[0]?.results ?? []);
      } catch (err) {
        reject(new Error(`Could not parse wrangler --json output: ${err.message}\nRaw stdout: ${stdout}`));
      }
    });
  });
}

/** Escapes a single value for inline SQL text. Ops-script use only --
 * never used on the request path, where every query goes through
 * D1Client's real .bind() parameterization (lib/d1/client.ts). wrangler's
 * --command flag does not support bound parameters, so this is the only
 * option for a CLI-shelled script; kept deliberately narrow (strings and
 * null only) rather than a general-purpose SQL builder. */
export function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function sqlBool(value) {
  return value ? "1" : "0";
}
