/**
 * Generic "capture -> serve -> keep on failure -> replace + archive on
 * next success" snapshot store, shared by every domain that needs to
 * decouple its read path from a live query (signals, trends, and any
 * future consumer) -- see snapshot-persistence-plan.md at the repo root
 * for the full design this implements.
 *
 * Two tables, one (domain, entity_key) composite key:
 *   snapshots_current  -- one row per key, overwritten in place
 *   snapshots_history  -- append-only, one row per successful write
 *
 * Zero project-specific imports (no @hiring-signals/* references) --
 * copy this file wholesale into another project, same convention as
 * every other lib/ module (see lib/README.md).
 *
 * Depends on ../http/circuit-breaker.ts only indirectly, via whatever
 * D1Client the caller passes in (this file has no import of its own
 * beyond the D1Client type shape it expects).
 */

/**
 * Minimal D1 client surface this module needs -- structurally
 * compatible with (but not importing) packages/db/src/d1-client.ts's
 * D1Client, so this file has zero project-specific dependency.
 */
export interface SnapshotD1Client {
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface SnapshotRow {
  domain: string;
  entity_key: string;
  payload_json: string;
  captured_at: string;
}

/**
 * Writes one snapshot: appends to snapshots_history, then upserts
 * snapshots_current. This order is deliberate -- if the process dies
 * between the two statements, the history row is already durably
 * recorded (worst case: an extra history row with no corresponding
 * "current" promotion yet, harmless and self-correcting on the next
 * successful call) rather than the current row moving forward with no
 * history trail behind it.
 *
 * "N-1" needs no separate copy step: the row occupying
 * snapshots_current right before this call overwrites it is already
 * sitting in snapshots_history from ITS OWN prior writeSnapshot() call
 * -- see this file's header comment.
 *
 * capturedAt is caller-supplied (not `new Date()` inside this function)
 * so callers writing several related keys in one capture run (e.g.
 * trends writing one row per role_category) can stamp them all with the
 * exact same timestamp, making a single capture run identifiable/
 * groupable in snapshots_history later if needed.
 */
export async function writeSnapshot(
  client: SnapshotD1Client,
  params: {
    domain: string;
    entityKey: string;
    payload: unknown;
    capturedAt: string;
  },
): Promise<void> {
  const payloadJson = JSON.stringify(params.payload);

  await client.run(
    `INSERT INTO snapshots_history (id, domain, entity_key, payload_json, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), params.domain, params.entityKey, payloadJson, params.capturedAt],
  );

  await client.run(
    `INSERT INTO snapshots_current (domain, entity_key, payload_json, captured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (domain, entity_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       captured_at = excluded.captured_at`,
    [params.domain, params.entityKey, payloadJson, params.capturedAt],
  );
}

/**
 * Reads the current snapshot for one (domain, entityKey). Returns null
 * only when this key has never been captured -- never throws, and
 * never expresses "no fresh data" as an error, since this store has no
 * freshness/TTL concept at all (see this file's header comment).
 */
export async function readSnapshot<T>(
  client: SnapshotD1Client,
  params: { domain: string; entityKey: string },
): Promise<{ payload: T; capturedAt: string } | null> {
  const row = await client.first<SnapshotRow>(
    `SELECT domain, entity_key, payload_json, captured_at
     FROM snapshots_current
     WHERE domain = ? AND entity_key = ?`,
    [params.domain, params.entityKey],
  );
  if (!row) return null;
  return { payload: JSON.parse(row.payload_json) as T, capturedAt: row.captured_at };
}

/**
 * Reads every current snapshot row for a domain, keyed by entity_key --
 * the shape a caller like trends.ts needs when it must fan out over
 * several entity_keys at once (one per role_category) rather than a
 * single point lookup. Order is not guaranteed; callers that need a
 * specific order should sort in application code.
 */
export async function readSnapshotsForDomain<T>(
  client: SnapshotD1Client,
  params: { domain: string; entityKeys?: string[] },
): Promise<Map<string, { payload: T; capturedAt: string }>> {
  const result = new Map<string, { payload: T; capturedAt: string }>();

  let rows: SnapshotRow[];
  if (params.entityKeys && params.entityKeys.length > 0) {
    const placeholders = params.entityKeys.map(() => "?").join(",");
    rows = await client.all<SnapshotRow>(
      `SELECT domain, entity_key, payload_json, captured_at
       FROM snapshots_current
       WHERE domain = ? AND entity_key IN (${placeholders})`,
      [params.domain, ...params.entityKeys],
    );
  } else {
    rows = await client.all<SnapshotRow>(
      `SELECT domain, entity_key, payload_json, captured_at
       FROM snapshots_current
       WHERE domain = ?`,
      [params.domain],
    );
  }

  for (const row of rows) {
    result.set(row.entity_key, {
      payload: JSON.parse(row.payload_json) as T,
      capturedAt: row.captured_at,
    });
  }
  return result;
}

/**
 * Reads the N most recent history rows for a key, most-recent-first
 * (uses idx_snapshots_history_lookup, migration 0011). limit=2 gets you
 * "current + N-1" without a separate snapshots_current read -- row[0]
 * is what's currently live, row[1] is what preceded it, etc. -- though
 * most callers should prefer readSnapshot() for "what's live right now"
 * since it's a direct point lookup on the smaller table.
 */
export async function readSnapshotHistory<T>(
  client: SnapshotD1Client,
  params: { domain: string; entityKey: string; limit: number },
): Promise<Array<{ payload: T; capturedAt: string }>> {
  const rows = await client.all<SnapshotRow>(
    `SELECT domain, entity_key, payload_json, captured_at
     FROM snapshots_history
     WHERE domain = ? AND entity_key = ?
     ORDER BY captured_at DESC
     LIMIT ?`,
    [params.domain, params.entityKey, params.limit],
  );
  return rows.map((row) => ({
    payload: JSON.parse(row.payload_json) as T,
    capturedAt: row.captured_at,
  }));
}
