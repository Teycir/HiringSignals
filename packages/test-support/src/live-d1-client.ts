/**
 * A real `D1Client` (packages/db's own interface, `lib/d1/client.ts`)
 * implementation backed by the live, remote `hiring-signals` D1
 * database -- per AGENTS.md's "zero mocks, zero fakes" testing policy.
 * No in-memory stand-in: every call here is a real network round trip
 * to Cloudflare, via `wrangler d1 execute hiring-signals --remote --json`
 * (see `./d1-remote-transport.ts`, this file's shared transport with
 * `createLiveD1Database` in `./live-d1-database.ts`), the same mechanism
 * `infrastructure/scripts/lib/d1-exec.mjs` already uses for the ops
 * scripts (there is no way to construct a live `D1Database` binding
 * outside a deployed Worker -- confirmed by that file's own header
 * comment, same constraint applies here).
 *
 * Lives in `@hiring-signals/test-support` (a real workspace package),
 * not inside `apps/api/test/lib/` where it originated (2026-07-30) --
 * `packages/db/test/*.test.ts` needs this exact same client and
 * `packages/db` cannot import from `apps/api` (wrong dependency
 * direction; `apps/api` depends on `packages/db`, not the reverse), and
 * this can't live in repo-root `lib/` either since that directory is
 * explicitly documented (`lib/README.md`) as project-agnostic with zero
 * `@hiring-signals/*` imports -- this file is neither. A real workspace
 * package under `packages/*` (already a pnpm-workspace.yaml glob, no
 * config change needed) is the correct fit: both `apps/api` and
 * `packages/db` (and any future test file) import it the same way any
 * other workspace dependency is imported.
 *
 * `wrangler d1 execute --command` has no bound-parameter flag (confirmed
 * via `wrangler d1 execute --help`, 2026-07-30 -- only `--command`/
 * `--file`, no parameter-binding option), so the shared transport
 * inlines values into the SQL text itself rather than using D1's native
 * `.bind()` placeholders the way the real request-path `createD1Client`
 * (lib/d1/client.ts) does. This is safe here specifically because every
 * caller is test code supplying literal, test-authored values (UUIDs,
 * enum strings, small integers) -- never end-user input -- and every
 * value still goes through `escapeSqlValue` (reusing the same
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
// Imported from lib/d1/client.ts directly, NOT from @hiring-signals/db
// (which re-exports the same type -- see packages/db/src/d1-client.ts's
// own header comment: "if you're fixing a bug here, fix it in
// lib/d1/client.ts, not here"). Importing the type from its true source
// avoids a `db -> test-support -> db` cycle in the pnpm workspace graph
// now that packages/db/test/*.test.ts also depends on test-support
// (ROADMAP.md Milestone J) -- pnpm's cycle detection doesn't distinguish
// dependencies from devDependencies, so the only real fix is not having
// the edge at all. lib/ is project-agnostic and has zero
// @hiring-signals/* imports of its own (lib/README.md), so this adds no
// new cycle risk going forward.
import type { D1Client } from "../../../lib/d1/client";
import { execRemote, inlineParams } from "./d1-remote-transport";

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
