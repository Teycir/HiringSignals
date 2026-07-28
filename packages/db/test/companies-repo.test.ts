import { describe, expect, it } from "vitest";
import type { D1Client } from "../src/d1-client";
import { createCompany, DuplicateCompanyError } from "../src/companies-repo";

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

  it("passes optional fields through in the correct bind-parameter positions", async () => {
    const { client, calls } = createFakeClient();
    const row = await createCompany(client, {
      slug: "beta-labs",
      displayName: "Beta Labs",
      domain: "betalabs.io",
      industry: "fintech",
      employeeBand: "51-200",
    });

    // Exact positional check, not expect.arrayContaining -- arrayContaining
    // would still pass if slug/displayName were swapped, or if domain was
    // bound into industry's position, since it only checks membership, not
    // order. Params must match the column list exactly: (id, slug,
    // display_name, domain, industry, employee_band, created_at, updated_at).
    expect(calls).toHaveLength(1);
    const params = calls[0]?.params;
    expect(params).toHaveLength(8);
    expect(params?.[0]).toBe(row.id);
    expect(params?.[1]).toBe("beta-labs");
    expect(params?.[2]).toBe("Beta Labs");
    expect(params?.[3]).toBe("betalabs.io");
    expect(params?.[4]).toBe("fintech");
    expect(params?.[5]).toBe("51-200");
    expect(params?.[6]).toBe(row.created_at);
    expect(params?.[7]).toBe(row.updated_at);
    expect(params?.[6]).toBe(params?.[7]);
  });

  it("normalizes empty-string optionals to null, same as omitting them", async () => {
    const { client, calls } = createFakeClient();
    const row = await createCompany(client, {
      slug: "gamma-co",
      displayName: "Gamma Co",
      domain: "",
      industry: "",
      employeeBand: "",
    });

    expect(row.domain).toBeNull();
    expect(row.industry).toBeNull();
    expect(row.employee_band).toBeNull();
    expect(calls[0]?.params).toEqual([
      row.id,
      "gamma-co",
      "Gamma Co",
      null,
      null,
      null,
      row.created_at,
      row.updated_at,
    ]);
  });

  it("rejects blank/whitespace-only slug or displayName without hitting D1", async () => {
    const { client, calls } = createFakeClient();
    await expect(createCompany(client, { slug: "   ", displayName: "Acme Inc" })).rejects.toThrow(
      /blank\/whitespace-only/,
    );
    await expect(createCompany(client, { slug: "acme-inc", displayName: "  " })).rejects.toThrow(
      /blank\/whitespace-only/,
    );
    // Neither rejected call should have reached the D1 client at all.
    expect(calls).toHaveLength(0);
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
