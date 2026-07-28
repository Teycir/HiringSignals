/**
 * D1 error-classification helpers shared across repo modules.
 *
 * D1's error shapes aren't typed classes -- they surface as a plain
 * `Error` whose `message` contains SQLite's own text. Every repo module
 * that needs to distinguish "this specific constraint/condition failed"
 * from "some other D1 error" matches on that text, so the matching logic
 * lives here once instead of copy-pasted per file (previously duplicated
 * in sources-repo.ts and companies-repo.ts, each with a comment
 * explaining why it *wasn't* shared -- code review flagged that the
 * three-way duplication, including a third copy in the ingest consumer's
 * observation-idempotency check, was worth fixing once this module
 * exists).
 *
 * Not exported from index.ts -- this is package-internal, not part of
 * @hiring-signals/db's public API.
 */

/**
 * True if `err` is a D1 UNIQUE constraint violation. Used by
 * createSource/createCompany to map a raw D1 error into a typed
 * DuplicateSourceError/DuplicateCompanyError.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
