import { afterEach, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany, DuplicateCompanyError } from "../src/companies-repo";

/**
 * Migrated off the retired in-memory-fake `D1Client` (AGENTS.md's "zero
 * mocks, zero fakes" policy, superseded 2026-07-30; ROADMAP.md Milestone
 * J) onto the real, live, shared `hiring-signals` D1 database via
 * `@hiring-signals/test-support`'s `createLiveD1Client`, same pattern as
 * `company-role-stats-repo.test.ts`.
 *
 * The fake's SQL-substring/positional-param-array assertions (does the
 * built INSERT contain "INSERT INTO companies", is `params[3]` exactly
 * `null` in the right slot) have no live equivalent -- a live client has
 * no "what SQL was I sent" introspection point (see
 * company-role-stats-repo.test.ts's header comment for the same
 * reasoning). Each such assertion becomes a real insert + real read-back
 * assertion on the returned `CompanyRow` instead: same output-shape
 * checks (`row.domain === null`, `row.created_at === row.updated_at`),
 * verified against a row that genuinely exists in D1, not a captured SQL
 * string.
 *
 * The DuplicateCompanyError test previously threw a hand-crafted
 * `Error("D1_ERROR: UNIQUE constraint failed: companies.slug")` from the
 * fake. Confirmed directly against the real database (2026-07-30, via a
 * throwaway probe insert/duplicate-insert/cleanup) that a real UNIQUE
 * violation from `wrangler d1 execute --remote` surfaces the literal
 * text "UNIQUE constraint failed: companies.slug: SQLITE_CONSTRAINT..."
 * in its JSON error output, which `createLiveD1Client`'s `run()` rejects
 * with -- so `isUniqueConstraintError`'s case-insensitive substring
 * match on "UNIQUE constraint failed" fires correctly against the real
 * error, not just the fake's scripted one. This test now inserts the
 * same slug twice for real instead of scripting the client to throw.
 *
 * Every test uses a `test-cr-`-prefixed slug (`cr` = companies-repo,
 * this file) and deletes its own row in a `finally`, per AGENTS.md's
 * "shared instance, not isolated" -- same discipline as
 * company-role-stats-repo.test.ts. `afterEach` is the same
 * belt-and-suspenders second cleanup pass.
 */

const TEST_PREFIX = "test-cr";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

async function cleanupCompany(companyId: string): Promise<void> {
  await client.run(`DELETE FROM companies WHERE id = ?`, [companyId]);
}

/** Belt-and-suspenders sweep for anything left behind by a run that
 * didn't reach its own `finally` (hard kill, etc.) -- matches on the
 * shared TEST_PREFIX rather than a specific id. */
afterEach(async () => {
  await client.run(`DELETE FROM companies WHERE slug LIKE ?`, [`${TEST_PREFIX}-%`]);
});

describe("createCompany", () => {
  it("inserts with a generated id, sets created_at = updated_at, nullable fields omitted -> null", async () => {
    const slug = testSlug("basic");
    const row = await createCompany(client, {
      slug,
      displayName: "Acme Inc",
    });
    try {
      expect(row.id).toBeTruthy();
      expect(row.slug).toBe(slug);
      expect(row.display_name).toBe("Acme Inc");
      expect(row.domain).toBeNull();
      expect(row.industry).toBeNull();
      expect(row.employee_band).toBeNull();
      expect(row.created_at).toBe(row.updated_at);

      // Real read-back, not just the function's return value -- confirms
      // the row genuinely persisted with these exact column values.
      const persisted = await client.first<{
        id: string;
        slug: string;
        display_name: string;
        domain: string | null;
        industry: string | null;
        employee_band: string | null;
        created_at: string;
        updated_at: string;
      }>(`SELECT * FROM companies WHERE id = ?`, [row.id]);
      expect(persisted).not.toBeNull();
      expect(persisted?.slug).toBe(slug);
      expect(persisted?.display_name).toBe("Acme Inc");
      expect(persisted?.domain).toBeNull();
      expect(persisted?.industry).toBeNull();
      expect(persisted?.employee_band).toBeNull();
      expect(persisted?.created_at).toBe(persisted?.updated_at);
    } finally {
      await cleanupCompany(row.id);
    }
  });

  it("persists optional fields (domain, industry, employeeBand) correctly", async () => {
    const slug = testSlug("optionals");
    const row = await createCompany(client, {
      slug,
      displayName: "Beta Labs",
      domain: "betalabs.io",
      industry: "fintech",
      employeeBand: "51-200",
    });
    try {
      expect(row.domain).toBe("betalabs.io");
      expect(row.industry).toBe("fintech");
      expect(row.employee_band).toBe("51-200");
      expect(row.created_at).toBe(row.updated_at);

      const persisted = await client.first<{
        domain: string | null;
        industry: string | null;
        employee_band: string | null;
      }>(`SELECT domain, industry, employee_band FROM companies WHERE id = ?`, [row.id]);
      expect(persisted?.domain).toBe("betalabs.io");
      expect(persisted?.industry).toBe("fintech");
      expect(persisted?.employee_band).toBe("51-200");
    } finally {
      await cleanupCompany(row.id);
    }
  });

  it("normalizes empty-string optionals to null, same as omitting them", async () => {
    const slug = testSlug("empty-optionals");
    const row = await createCompany(client, {
      slug,
      displayName: "Gamma Co",
      domain: "",
      industry: "",
      employeeBand: "",
    });
    try {
      expect(row.domain).toBeNull();
      expect(row.industry).toBeNull();
      expect(row.employee_band).toBeNull();

      const persisted = await client.first<{
        domain: string | null;
        industry: string | null;
        employee_band: string | null;
      }>(`SELECT domain, industry, employee_band FROM companies WHERE id = ?`, [row.id]);
      expect(persisted?.domain).toBeNull();
      expect(persisted?.industry).toBeNull();
      expect(persisted?.employee_band).toBeNull();
    } finally {
      await cleanupCompany(row.id);
    }
  });

  it("rejects blank/whitespace-only slug or displayName without hitting D1", async () => {
    // No client instrumentation needed to prove "never reached D1" --
    // if either call did reach the real client, it would either persist
    // a bogus row (never cleaned up, since this test does no cleanup) or
    // throw a different error. Asserting the specific validation error
    // message is the real behavioral guarantee here; the fake's "0 calls
    // recorded" assertion added nothing beyond that against a live client.
    await expect(createCompany(client, { slug: "   ", displayName: "Acme Inc" })).rejects.toThrow(
      /blank\/whitespace-only/,
    );
    await expect(createCompany(client, { slug: "acme-inc", displayName: "  " })).rejects.toThrow(
      /blank\/whitespace-only/,
    );
  });

  it("throws DuplicateCompanyError (not a raw D1 error) on a real UNIQUE constraint violation", async () => {
    const slug = testSlug("dup");
    const first = await createCompany(client, { slug, displayName: "Acme Inc" });
    try {
      // One duplicate-insert attempt, asserted on twice -- avoids a
      // second real network round trip just to re-check the message.
      let caught: unknown;
      try {
        await createCompany(client, { slug, displayName: "Acme Inc Again" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicateCompanyError);
      expect((caught as Error).message).toMatch(new RegExp(`slug="${slug}"`));
    } finally {
      await cleanupCompany(first.id);
    }
  });
});
