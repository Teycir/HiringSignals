import { describe, expect, it } from "vitest";
import type { D1Client } from "../src/d1-client";
import { getCompanyRoleActivityStats } from "../src/company-role-stats-repo";

/**
 * Fake D1Client test double, same style as signals-write-repo.test.ts /
 * companies-repo.test.ts (plain object literal, not vi.fn()-wrapped, so
 * D1Client's generic method signatures stay intact).
 */
function createFakeClient(seededFirstResult: unknown = null): {
  client: D1Client;
  calls: Array<{ method: string; sql: string; params: unknown[] }>;
} {
  const calls: Array<{ method: string; sql: string; params: unknown[] }> = [];
  const client: D1Client = {
    async first<T>(sql: string, params: unknown[] = []) {
      calls.push({ method: "first", sql, params });
      return seededFirstResult as T | null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      calls.push({ method: "all", sql, params });
      return [] as T[];
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

describe("getCompanyRoleActivityStats", () => {
  it("queries by company_id + role_category, binding `now` for all three date-window checks", async () => {
    const { client, calls } = createFakeClient();
    await getCompanyRoleActivityStats(client, {
      companyId: "c1",
      roleCategory: "cybersecurity",
      now: "2026-07-29T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("FROM jobs");
    expect(calls[0]?.sql).toContain("WHERE company_id = ? AND role_primary = ?");
    // now is bound 4 times (two range checks each need a lower+upper
    // bound derived from it) before the trailing companyId/roleCategory.
    expect(calls[0]?.params).toEqual([
      "2026-07-29T00:00:00Z",
      "2026-07-29T00:00:00Z",
      "2026-07-29T00:00:00Z",
      "2026-07-29T00:00:00Z",
      "c1",
      "cybersecurity",
    ]);
  });

  it("returns all zeros (never null/undefined) when no jobs exist for this company+role", async () => {
    const { client } = createFakeClient(null);
    const result = await getCompanyRoleActivityStats(client, {
      companyId: "c1",
      roleCategory: "cybersecurity",
      now: "2026-07-29T00:00:00Z",
    });
    expect(result).toEqual({
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
  });

  it("passes through real aggregated counts from the fake client's seeded row", async () => {
    const { client } = createFakeClient({
      active_matching_count: 7,
      new_in_last_14_days: 3,
      new_in_prior_56_days: 8,
      distinct_location_count: 4,
    });
    const result = await getCompanyRoleActivityStats(client, {
      companyId: "c1",
      roleCategory: "cloud_platform_devops_sre",
      now: "2026-07-29T00:00:00Z",
    });
    expect(result).toEqual({
      activeMatchingCount: 7,
      newInLast14Days: 3,
      newInPrior56Days: 8,
      distinctLocationCount: 4,
    });
  });

  it("treats an explicit 0 in every field as a real zero, not the null-fallback path", async () => {
    // Distinguishes "SQLite's SUM/COUNT returned real 0s because rows
    // exist but none matched the CASE conditions" from "first() returned
    // null because there were no rows to aggregate at all" -- both must
    // produce the same all-zero result, so this covers the row-exists
    // branch specifically (the row-is-null branch is the prior test).
    const { client } = createFakeClient({
      active_matching_count: 0,
      new_in_last_14_days: 0,
      new_in_prior_56_days: 0,
      distinct_location_count: 0,
    });
    const result = await getCompanyRoleActivityStats(client, {
      companyId: "c1",
      roleCategory: "cybersecurity",
      now: "2026-07-29T00:00:00Z",
    });
    expect(result).toEqual({
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
  });
});
