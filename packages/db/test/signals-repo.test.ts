import { describe, expect, it } from "vitest";
import type { D1Client } from "../src/d1-client";
import {
  CorruptSignalRowError,
  InvalidCursorError,
  findSignalsByJobIds,
  listSignals,
  toListItem,
  type SignalRow,
} from "../src/signals-repo";

/**
 * Fake D1Client test double, same style as company-role-stats-repo.test.ts /
 * signals-write-repo.test.ts (plain object literal, not vi.fn()-wrapped,
 * so D1Client's generic method signatures stay intact). `allResults`
 * seeds what `.all()` returns; every call is still recorded in `calls`
 * for SQL/param-shape assertions.
 */
function createFakeClient(allResults: unknown[] = []): {
  client: D1Client;
  calls: Array<{ method: string; sql: string; params: unknown[] }>;
} {
  const calls: Array<{ method: string; sql: string; params: unknown[] }> = [];
  const client: D1Client = {
    async first<T>(sql: string, params: unknown[] = []) {
      calls.push({ method: "first", sql, params });
      return null as T | null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      calls.push({ method: "all", sql, params });
      return allResults as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      calls.push({ method: "run", sql, params });
      return { changes: 1 };
    },
    async batch<T>() {
      return [] as T[][];
    },
  };
  return { client, calls };
}

function makeRow(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "sig-1",
    company_id: "c1",
    company_slug: "acme",
    company_display_name: "Acme Corp",
    role_category: "cybersecurity",
    signal_type: "new_job",
    status: "active",
    score: 72,
    score_version: "v2",
    first_detected_at: "2026-07-20T00:00:00.000Z",
    last_detected_at: "2026-07-28T00:00:00.000Z",
    expires_at: null,
    headline: "New Cybersecurity role at Acme",
    summary: "Acme posted a new Security Engineer role.",
    ...overrides,
  };
}

describe("listSignals", () => {
  it("always filters status='active' and applies the minScore/observedSince defaults", async () => {
    const { client, calls } = createFakeClient([]);
    await listSignals(client, { minScore: 0, sort: "score_desc", limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("s.status = 'active'");
    expect(calls[0]?.sql).toContain("s.score >= ?");
    expect(calls[0]?.sql).toContain("s.last_detected_at >= ?");
    // minScore default (0) is bound; observedSince falls back to "now - 30d",
    // so just assert a value was bound, not the exact computed timestamp.
    expect(calls[0]?.params).toContain(0);
  });

  it("q applies a LIKE match across headline/summary/company display name only", async () => {
    const { client, calls } = createFakeClient([]);
    await listSignals(client, { q: "rust", minScore: 0, sort: "score_desc", limit: 50 });
    expect(calls[0]?.sql).toContain("s.headline LIKE ?");
    expect(calls[0]?.sql).toContain("s.summary LIKE ?");
    expect(calls[0]?.sql).toContain("c.display_name LIKE ?");
    expect(calls[0]?.params).toEqual(expect.arrayContaining(["%rust%", "%rust%", "%rust%"]));
  });

  it("orders by score_desc/last_detected_at/id by default", async () => {
    const { client, calls } = createFakeClient([]);
    await listSignals(client, { minScore: 0, sort: "score_desc", limit: 50 });
    expect(calls[0]?.sql).toContain("ORDER BY s.score DESC, s.last_detected_at DESC, s.id DESC");
  });

  it("orders by last_detected_at DESC, id DESC for sort=newest", async () => {
    const { client, calls } = createFakeClient([]);
    await listSignals(client, { minScore: 0, sort: "newest", limit: 50 });
    expect(calls[0]?.sql).toContain("ORDER BY s.last_detected_at DESC, s.id DESC");
  });

  it("returns items mapped from rows and no nextCursor when fewer than limit+1 rows come back", async () => {
    const { client } = createFakeClient([makeRow()]);
    const result = await listSignals(client, { minScore: 0, sort: "score_desc", limit: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("sig-1");
    expect(result.items[0]?.companySlug).toBe("acme");
    expect(result.nextCursor).toBeNull();
  });

  it("sets nextCursor and trims to `limit` when limit+1 rows come back", async () => {
    const rows = [makeRow({ id: "sig-1" }), makeRow({ id: "sig-2" })];
    const { client } = createFakeClient(rows);
    const result = await listSignals(client, { minScore: 0, sort: "score_desc", limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("sig-1");
    expect(result.nextCursor).not.toBeNull();
  });

  it("skips a row with a corrupt role_category instead of throwing for the whole page", async () => {
    const rows = [
      makeRow({ id: "sig-bad", role_category: "not_a_real_category" }),
      makeRow({ id: "sig-good" }),
    ];
    const { client } = createFakeClient(rows);
    const result = await listSignals(client, { minScore: 0, sort: "score_desc", limit: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("sig-good");
  });

  it("throws InvalidCursorError when a cursor's embedded sort mode doesn't match the request", async () => {
    const { client } = createFakeClient([]);
    const cursorForNewest = Buffer.from(
      JSON.stringify({
        sort: "newest",
        score: 10,
        lastDetectedAt: "2026-07-01T00:00:00.000Z",
        companyDisplayName: "Acme",
        id: "sig-1",
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(
      listSignals(client, {
        minScore: 0,
        sort: "score_desc",
        cursor: cursorForNewest,
        limit: 50,
      }),
    ).rejects.toThrow(InvalidCursorError);
  });
});

describe("findSignalsByJobIds", () => {
  it("returns [] without querying D1 when jobIds is empty", async () => {
    const { client, calls } = createFakeClient([]);
    const result = await findSignalsByJobIds(client, [], { minScore: 0 });
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("queries active signals via a DISTINCT signal_evidence.job_id IN (...) subquery", async () => {
    const { client, calls } = createFakeClient([]);
    await findSignalsByJobIds(client, ["job-1", "job-2"], { minScore: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("s.status = 'active'");
    expect(calls[0]?.sql).toContain("SELECT DISTINCT se.signal_id FROM signal_evidence se");
    expect(calls[0]?.sql).toContain("se.job_id IN (?,?)");
    expect(calls[0]?.params).toEqual(expect.arrayContaining(["job-1", "job-2"]));
  });

  it("applies the same roles/locationMode/minScore filters as listSignals, so a semantic hit can't bypass them", async () => {
    const { client, calls } = createFakeClient([]);
    await findSignalsByJobIds(client, ["job-1"], {
      roles: ["cybersecurity"],
      locationMode: "remote",
      minScore: 60,
    });
    expect(calls[0]?.sql).toContain("s.role_category IN (?)");
    expect(calls[0]?.sql).toContain("j.location_mode = ?");
    expect(calls[0]?.sql).toContain("s.score >= ?");
    expect(calls[0]?.params).toEqual(
      expect.arrayContaining(["cybersecurity", "remote", 60, "job-1"]),
    );
  });

  it("does not accept q or cursor/sort params (not part of the filters type)", async () => {
    // Type-level guarantee: this test exists mainly to document intent --
    // if someone widens `filters` to accept `q`/`cursor`/`sort` later,
    // a compile-time review should catch it, not silent runtime drift.
    const { client } = createFakeClient([]);
    const result = await findSignalsByJobIds(client, ["job-1"], { minScore: 0 });
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns raw SignalRow[] (not SignalListItem[]) -- caller converts via toListItem", async () => {
    const row = makeRow({ id: "sig-semantic" });
    const { client } = createFakeClient([row]);
    const result = await findSignalsByJobIds(client, ["job-1"], { minScore: 0 });
    expect(result).toEqual([row]);
  });
});

describe("toListItem", () => {
  it("maps a valid SignalRow to a SignalListItem with camelCase fields", () => {
    const item = toListItem(makeRow());
    expect(item).toEqual({
      id: "sig-1",
      companyId: "c1",
      companySlug: "acme",
      companyDisplayName: "Acme Corp",
      roleCategory: "cybersecurity",
      signalType: "new_job",
      status: "active",
      score: 72,
      scoreVersion: "v2",
      firstDetectedAt: "2026-07-20T00:00:00.000Z",
      lastDetectedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: null,
      headline: "New Cybersecurity role at Acme",
      summary: "Acme posted a new Security Engineer role.",
    });
  });

  it("throws CorruptSignalRowError for an invalid signal_type", () => {
    expect(() => toListItem(makeRow({ signal_type: "not_a_real_type" }))).toThrow(
      CorruptSignalRowError,
    );
  });

  it("throws CorruptSignalRowError for an invalid status", () => {
    expect(() => toListItem(makeRow({ status: "not_a_real_status" }))).toThrow(
      CorruptSignalRowError,
    );
  });
});
