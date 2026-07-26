/**
 * Thin D1 client wrapper (spec 14.1). Every query goes through `.bind()`
 * with placeholders -- callers never interpolate values into SQL text.
 * This is the only file allowed to touch `D1Database` directly; repository
 * modules call these helpers instead of `env.DB.prepare(...)` themselves.
 */

export interface D1Client {
  /** Zero-or-one row. */
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Zero-or-more rows. */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE. Returns rows affected. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Multiple statements in one round trip (read-only batch use here). */
  batch<T>(statements: Array<{ sql: string; params?: unknown[] }>): Promise<T[][]>;
}

export function createD1Client(db: D1Database): D1Client {
  return {
    async first<T>(sql: string, params: unknown[] = []) {
      const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const row = await stmt.first<T>();
      return row ?? null;
    },

    async all<T>(sql: string, params: unknown[] = []) {
      const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const { results } = await stmt.all<T>();
      return results ?? [];
    },

    async run(sql: string, params: unknown[] = []) {
      const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const result = await stmt.run();
      return { changes: result.meta?.changes ?? 0 };
    },

    async batch<T>(statements: Array<{ sql: string; params?: unknown[] }>) {
      const prepared = statements.map(({ sql, params = [] }) =>
        params.length ? db.prepare(sql).bind(...params) : db.prepare(sql),
      );
      const results = await db.batch<T>(prepared);
      return results.map((r) => r.results ?? []);
    },
  };
}
