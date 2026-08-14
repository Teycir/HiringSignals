import { afterAll, describe, expect, it } from "vitest";
import { createLiveD1Client } from "@hiring-signals/test-support";
import type { D1Client } from "../src/d1-client";
import { createCompany } from "../src/companies-repo";
import {
  createSource,
  updateSource,
  markSourceSuccess,
  markSourceFailure,
  hasRecentRunningRun,
  resolveSourceRun,
  DuplicateSourceError,
} from "../src/sources-repo";

/**
 * First test file for sources-repo.ts (debug-codebase-audit.md H1 gap:
 * this file previously had zero test coverage at all). Same live-D1
 * conventions as the rest of packages/db/test/ (createLiveD1Client,
 * test-src slug prefix, FK-safe finally cleanup + afterAll sweep).
 *
 * Primary focus is the H1 tenant-isolation defense-in-depth added to
 * updateSource/markSourceSuccess/markSourceFailure: a wrong companyId
 * paired with a genuine sourceId must affect 0 rows, not silently
 * mutate (or, worse, succeed against) another company's source. Each
 * covered function gets both a happy-path test and a wrong-companyId
 * isolation test, per the audit doc's own verification instruction.
 */

const TEST_PREFIX = "test-src";
let seq = 0;
function testSlug(label: string): string {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}-${Date.now()}`;
}

const client: D1Client = createLiveD1Client();

/** FK-safe delete, one client.batch() call (D1's real atomicity
 * primitive -- see lib/d1/client.ts's batch() header comment).
 *
 * `source_runs` deleted before `sources` (2026-08-05, added
 * defensively for consistency with every other file in this package --
 * see company-role-stats-repo.test.ts's header comment for the
 * reproduced `FOREIGN KEY constraint failed` this ordering avoids).
 * This file's own tests never call recordSourceRunStart/resolveSourceRun
 * themselves, so under normal execution there is no source_runs row for
 * this file's own sources to violate; this guards against a source_runs
 * row attaching to one of this file's sources via any other path
 * (future code change, cross-test contamination) without this file's
 * cleanup starting to fail with an FK error that looks unrelated to
 * source_runs entirely. */
async function cleanupCompany(companyId: string): Promise<void> {
  await client.batch([
    {
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id = ?)`,
      params: [companyId],
    },
    { sql: `DELETE FROM sources WHERE company_id = ?`, params: [companyId] },
    { sql: `DELETE FROM companies WHERE id = ?`, params: [companyId] },
  ]);
}

/** Belt-and-suspenders sweep, same TEST_PREFIX-matching pattern as the
 * rest of this directory. Runs in `afterAll`, not `afterEach`
 * (2026-08-05, same fix as ingest-consumer.test.ts/
 * company-role-stats-repo.test.ts/signals-export-repo.test.ts/
 * signals-repo.test.ts) -- a global `test-src-%` prefix sweep firing
 * between every test can race a sibling test's still-in-flight rows
 * under vitest's scheduling; see those files' header comments for the
 * reproduced `FOREIGN KEY constraint failed` this caused. */
afterAll(async () => {
  await client.batch([
    {
      // Same source_runs-before-sources ordering as cleanupCompany
      // above, for the same defensive reasoning.
      sql: `DELETE FROM source_runs WHERE source_id IN (SELECT id FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?))`,
      params: [`${TEST_PREFIX}-%`],
    },
    {
      sql: `DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE ?)`,
      params: [`${TEST_PREFIX}-%`],
    },
    { sql: `DELETE FROM companies WHERE slug LIKE ?`, params: [`${TEST_PREFIX}-%`] },
  ]);
});

async function seedCompany(label: string, displayName: string) {
  const slug = testSlug(label);
  return createCompany(client, { slug, displayName });
}

async function seedSource(companyId: string, companySlug: string) {
  return createSource(client, {
    companyId,
    provider: "greenhouse",
    boardToken: companySlug,
    publicUrl: `https://example.invalid/${companySlug}`,
  });
}

describe("createSource", () => {
  it("inserts a source with enabled=true, next_poll_at NULL, consecutive_failures 0 by default", async () => {
    const company = await seedCompany("cs-basic", "Create Source Co");
    try {
      const source = await seedSource(company.id, company.slug);
      expect(source.id).toBeTruthy();
      expect(source.company_id).toBe(company.id);
      expect(source.enabled).toBe(1);
      expect(source.next_poll_at).toBeNull();
      expect(source.consecutive_failures).toBe(0);

      const persisted = await client.first<{ id: string; company_id: string; enabled: number }>(
        `SELECT id, company_id, enabled FROM sources WHERE id = ?`,
        [source.id],
      );
      expect(persisted?.company_id).toBe(company.id);
      expect(persisted?.enabled).toBe(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("throws DuplicateSourceError on a (provider, board_token) collision", async () => {
    const company = await seedCompany("cs-dup", "Create Source Dup Co");
    try {
      await seedSource(company.id, company.slug);
      await expect(seedSource(company.id, company.slug)).rejects.toBeInstanceOf(DuplicateSourceError);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("updateSource", () => {
  it("updates only the fields present in the patch, scoped to the correct company_id", async () => {
    const company = await seedCompany("us-basic", "Update Source Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const ok = await updateSource(client, source.id, company.id, {
        enabled: false,
        pollIntervalMinutes: 90,
      });
      expect(ok).toBe(true);

      const persisted = await client.first<{
        enabled: number;
        poll_interval_minutes: number;
        public_url: string;
      }>(`SELECT enabled, poll_interval_minutes, public_url FROM sources WHERE id = ?`, [source.id]);
      expect(persisted?.enabled).toBe(0);
      expect(persisted?.poll_interval_minutes).toBe(90);
      // public_url untouched -- not present in the patch.
      expect(persisted?.public_url).toBe(`https://example.invalid/${company.slug}`);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: affects 0 rows and does not change data when passed a mismatched company_id", async () => {
    const company = await seedCompany("us-tenant", "Update Source Tenant Co");
    const otherCompany = await seedCompany("us-tenant-other", "Update Source Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const ok = await updateSource(client, source.id, otherCompany.id, { enabled: false });
      expect(ok).toBe(false);

      const persisted = await client.first<{ enabled: number }>(
        `SELECT enabled FROM sources WHERE id = ?`,
        [source.id],
      );
      // Unchanged -- the wrong companyId meant 0 rows matched.
      expect(persisted?.enabled).toBe(1);
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });

  it("returns true and is a no-op when the patch has no fields set", async () => {
    const company = await seedCompany("us-empty-patch", "Update Source Empty Patch Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const ok = await updateSource(client, source.id, company.id, {});
      expect(ok).toBe(true);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("markSourceSuccess", () => {
  it("resets consecutive_failures to 0, sets last_success_at and next_poll_at", async () => {
    const company = await seedCompany("mss-basic", "Mark Success Co");
    try {
      const source = await seedSource(company.id, company.slug);
      // Seed a nonzero failure count via markSourceFailure so the reset is observable.
      await markSourceFailure(client, source.id, company.id);
      await markSourceFailure(client, source.id, company.id);

      const nextPollAt = "2026-08-05T00:00:00.000Z";
      await markSourceSuccess(client, source.id, company.id, nextPollAt);

      const persisted = await client.first<{
        consecutive_failures: number;
        last_success_at: string | null;
        next_poll_at: string | null;
      }>(`SELECT consecutive_failures, last_success_at, next_poll_at FROM sources WHERE id = ?`, [
        source.id,
      ]);
      expect(persisted?.consecutive_failures).toBe(0);
      expect(persisted?.last_success_at).not.toBeNull();
      expect(persisted?.next_poll_at).toBe(nextPollAt);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not reset another company's source when passed a mismatched company_id", async () => {
    const company = await seedCompany("mss-tenant", "Mark Success Tenant Co");
    const otherCompany = await seedCompany("mss-tenant-other", "Mark Success Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await markSourceFailure(client, source.id, company.id);

      // Wrong companyId -- must not reset the failure count.
      await markSourceSuccess(client, source.id, otherCompany.id, "2026-08-05T00:00:00.000Z");

      const persisted = await client.first<{
        consecutive_failures: number;
        next_poll_at: string | null;
      }>(`SELECT consecutive_failures, next_poll_at FROM sources WHERE id = ?`, [source.id]);
      expect(persisted?.consecutive_failures).toBe(1);
      expect(persisted?.next_poll_at).toBeNull();
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });
});

describe("markSourceFailure", () => {
  it("increments consecutive_failures when called with a matching companyId", async () => {
    const company = await seedCompany("msf-basic", "Mark Failure Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await markSourceFailure(client, source.id, company.id);
      await markSourceFailure(client, source.id, company.id);

      const persisted = await client.first<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM sources WHERE id = ?`,
        [source.id],
      );
      expect(persisted?.consecutive_failures).toBe(2);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("H1: does not increment another company's source when passed a mismatched company_id", async () => {
    const company = await seedCompany("msf-tenant", "Mark Failure Tenant Co");
    const otherCompany = await seedCompany("msf-tenant-other", "Mark Failure Other Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await markSourceFailure(client, source.id, otherCompany.id);

      const persisted = await client.first<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM sources WHERE id = ?`,
        [source.id],
      );
      // Unchanged -- wrong companyId matched 0 rows.
      expect(persisted?.consecutive_failures).toBe(0);
    } finally {
      await cleanupCompany(company.id);
      await cleanupCompany(otherCompany.id);
    }
  });

  it("documented exception: increments by sourceId alone when companyId is omitted", async () => {
    // The two real call sites for this path are outer catch blocks in
    // ingest-consumer.ts that genuinely lack a loaded source row (see
    // sources-repo.ts's own doc comment on markSourceFailure). This test
    // exercises that documented fallback, not a gap.
    const company = await seedCompany("msf-no-company", "Mark Failure No Company Co");
    try {
      const source = await seedSource(company.id, company.slug);
      await markSourceFailure(client, source.id);

      const persisted = await client.first<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM sources WHERE id = ?`,
        [source.id],
      );
      expect(persisted?.consecutive_failures).toBe(1);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});

describe("hasRecentRunningRun", () => {
  it("returns false when the source has no source_runs rows at all", async () => {
    const company = await seedCompany("hrr-none", "Has Running None Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const result = await hasRecentRunningRun(client, source.id, new Date().toISOString(), 45);
      expect(result).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns true when a running row started within the staleness window", async () => {
    const company = await seedCompany("hrr-running", "Has Running True Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date();
      await resolveSourceRun(client, source.id, crypto.randomUUID(), now.toISOString());

      const result = await hasRecentRunningRun(client, source.id, now.toISOString(), 45);
      expect(result).toBe(true);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns false when the only running row started before the staleness cutoff", async () => {
    const company = await seedCompany("hrr-stale", "Has Running Stale Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const startedAt = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
      await resolveSourceRun(client, source.id, crypto.randomUUID(), startedAt.toISOString());

      // 45-minute staleness window -- a run started 60 minutes ago is
      // outside it, so this must NOT be treated as in-flight (the
      // whole point of the cutoff: a genuinely abandoned run must not
      // block a source forever).
      const result = await hasRecentRunningRun(client, source.id, new Date().toISOString(), 45);
      expect(result).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("returns false when the run is recent but no longer status='running'", async () => {
    const company = await seedCompany("hrr-completed", "Has Running Completed Co");
    try {
      const source = await seedSource(company.id, company.slug);
      const now = new Date();
      const runId = crypto.randomUUID();
      await resolveSourceRun(client, source.id, runId, now.toISOString());
      // Flip the row to a completed state directly (this file's own
      // recordSourceRunComplete import would work equally well, but a
      // direct UPDATE keeps this test focused on the status filter
      // itself rather than that function's own behavior).
      await client.run(`UPDATE source_runs SET status = 'success' WHERE id = ?`, [runId]);

      const result = await hasRecentRunningRun(client, source.id, now.toISOString(), 45);
      expect(result).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });

  it("does not match another source's running row", async () => {
    const company = await seedCompany("hrr-other", "Has Running Other Co");
    try {
      const sourceA = await seedSource(company.id, `${company.slug}-a`);
      const sourceB = await createSource(client, {
        companyId: company.id,
        provider: "greenhouse",
        boardToken: `${company.slug}-b`,
        publicUrl: `https://example.invalid/${company.slug}-b`,
      });
      const now = new Date();
      await resolveSourceRun(client, sourceA.id, crypto.randomUUID(), now.toISOString());

      const result = await hasRecentRunningRun(client, sourceB.id, now.toISOString(), 45);
      expect(result).toBe(false);
    } finally {
      await cleanupCompany(company.id);
    }
  });
});
