/**
 * Escapes SQL LIKE wildcards (`%`, `_`) in user-supplied search input so
 * they're matched as literal characters instead of being interpreted as
 * wildcards. Without this, a query containing "%" or "_" (e.g. "R&D_Labs",
 * "50%_off") silently behaves as a wildcard pattern instead of a literal
 * substring match -- not a security hole by itself, but a correctness bug
 * that's easy to miss until someone searches for exactly the wrong string.
 *
 * Usage: pair with `ESCAPE '\'` in the SQL and wrap the result in `%...%`
 * (or your desired anchoring) before binding as a parameter.
 *
 *   const pattern = `%${escapeLikePattern(userInput)}%`;
 *   await db.all(`SELECT * FROM t WHERE name LIKE ? ESCAPE '\\'`, [pattern]);
 *
 * Zero project-specific dependencies -- copy this file into any project
 * that builds LIKE queries from user input (D1, SQLite, Postgres with
 * the same ESCAPE syntax, etc).
 */
export function escapeLikePattern(input: string): string {
  return input.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
