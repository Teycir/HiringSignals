/**
 * D1's error shapes aren't typed classes -- a constraint violation
 * surfaces as a plain `Error` whose `message` contains SQLite's own
 * text. This is a pure string check with no repo/schema coupling, so it
 * lives here rather than in packages/db's package-private internal/
 * module (where it previously lived as `internal/d1-errors.ts`) --
 * moved out after a code review noted that internal/ location meant a
 * stray `@hiring-signals/db/internal/d1-errors` import from another
 * workspace package could resolve at build time despite not being
 * re-exported from index.ts, since nothing enforces package.json
 * `exports` boundaries in this repo's Workers bundler setup. Living in
 * lib/ instead sidesteps that: it's meant to be imported directly by
 * any package that needs it (packages/db's repo modules, and the
 * ingest consumer's own idempotency check), same as escapeLikePattern
 * in this directory.
 *
 * Zero project-specific dependencies -- copy this file into any project
 * that needs to distinguish "this specific constraint failed" from
 * "some other D1 error" (D1, SQLite, any driver that surfaces the same
 * message text).
 *
 * Usage:
 *   try {
 *     await client.run(`INSERT INTO t (...) VALUES (...)`, [...]);
 *   } catch (err) {
 *     if (isUniqueConstraintError(err)) { ... }
 *     throw err;
 *   }
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
