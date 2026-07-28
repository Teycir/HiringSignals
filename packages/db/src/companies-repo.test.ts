import { describe, expect, it } from "vitest";
import type { D1Client } from "./d1-client";
import { createCompany, DuplicateCompanyError } from "./companies-repo";

/**
 * Fake D1Client test double, same style as signals-write-repo.test.ts
 * (plain object literal, not vi.fn()-wrapped, so D1Client's generic
 * method signatures stay intact -- see that file's header comment for
 * why vi.fn() wrapping breaks the generic type).
 */
function createFakeClient(opts: { runThrows?: Error } = {}): {
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
      return [] as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      calls.push({ method: "run", sql, params });
      if (opts.runThrows) throw opts.runThrows;
      return { changes: 1 };
    },
    async batch<T>() {
      return [] as T[][];
    },
  };
  return { client, calls };
}

describe("createCompany", () => {
  it("inserts with a generated id, sets created_at = updated_at, nullable fields omitted -> null", async () => {
    const { client, calls } = createFakeClient();
    const row = await createCompany(client, {
      slug: "acme-inc",
      displayName: "Acme Inc",
    });

    expect(row.id).toBeTruthy();
    expect(row.slug).toBe("acme-inc");
    expect(row.display_name).toBe("Acme Inc");
    expect(row.domain).toBeNull();
    expect(row.industry).toBeNull();
    expect(row.employee_band).toBeNull();
    expect(row.created_at).toBe(row.updated_at);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("INSERT INTO companies");
    expect(calls[0]?.params).toEqual([
      row.id,
      "acme-inc",
      "Acme Inc",
      null,
      null,
      null,
      row.created_at,
      row.updated_at,
    ]);
  });

  it("passes optional fields through when provided", async () => {
    const { client, calls } = createFakeClient();
    await createCompany(client, {
      slug: "beta-labs",
      displayName: "Beta Labs",
      domain: "betalabs.io",
      industry: "fintech",
      employeeBand: "51-200",
    });
    expect(calls[0]?.params).toEqual(
      expect.arrayContaining(["beta-labs", "Beta Labs", "betalabs.io", "fintech", "51-200"]),
    );
  });

  it("throws DuplicateCompanyError (not a raw D1 error) on a UNIQUE constraint violation", async () => {
    const { client } = createFakeClient({
      runThrows: new Error("D1_ERROR: UNIQUE constraint failed: companies.slug"),
    });
    await expect(createCompany(client, { slug: "acme-inc", displayName: "Acme Inc" })).rejects.toThrow(
      DuplicateCompanyError,
    );
    await expect(createCompany(client, { slug: "acme-inc", displayName: "Acme Inc" })).rejects.toThrow(
      /slug="acme-inc"/,
    );
  });

  it("re-throws a non-UNIQUE-constraint D1 error as-is", async () => {
    const { client } = createFakeClient({ runThrows: new Error("D1_ERROR: some other failure") });
    await expect(createCompany(client, { slug: "acme-inc", displayName: "Acme Inc" })).rejects.toThrow(
      "D1_ERROR: some other failure",
    );
  });
});
