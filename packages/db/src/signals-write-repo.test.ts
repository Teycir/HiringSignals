import { describe, expect, it } from "vitest";
import type { D1Client } from "./d1-client";
import {
  appendSignalEvidence,
  createSignal,
  findActiveSignal,
  refreshSignal,
} from "./signals-write-repo";

/**
 * Fake D1Client test double: records every call's SQL + params so tests
 * can assert on shape without a real D1 binding. Mirrors the interface
 * in d1-client.ts exactly (first/all/run/batch).
 *
 * Built as a plain object rather than via vi.fn() wrapping -- D1Client's
 * methods are generic (<T>(...) => Promise<T | ...>), and vi.fn() infers
 * a concrete non-generic signature from whatever arrow function it wraps,
 * which TS then can't assign back to the generic interface. A plain
 * object literal typed as D1Client keeps each method's own generic
 * signature intact.
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

describe("findActiveSignal", () => {
  it("queries by company_id + role_category + signal_type + status='active'", async () => {
    const { client, calls } = createFakeClient();
    await findActiveSignal(client, {
      companyId: "c1",
      roleCategory: "software_engineering",
      signalType: "new_job",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("status = 'active'");
    expect(calls[0]?.params).toEqual(["c1", "software_engineering", "new_job"]);
  });

  it("returns null when no active signal exists (fake client default)", async () => {
    const { client } = createFakeClient();
    const result = await findActiveSignal(client, {
      companyId: "c1",
      roleCategory: "software_engineering",
      signalType: "new_job",
    });
    expect(result).toBeNull();
  });

  it("returns the row when the fake client is seeded with one", async () => {
    const { client } = createFakeClient({
      id: "sig-1",
      status: "active",
      score: 72,
      first_detected_at: "2026-07-01T00:00:00Z",
      last_detected_at: "2026-07-20T00:00:00Z",
    });
    const result = await findActiveSignal(client, {
      companyId: "c1",
      roleCategory: "software_engineering",
      signalType: "new_job",
    });
    expect(result?.id).toBe("sig-1");
  });
});

describe("createSignal", () => {
  it("inserts with status='active' and expires_at NULL, first/last_detected_at both set to detectedAt", async () => {
    const { client, calls } = createFakeClient();
    const id = await createSignal(client, {
      companyId: "c1",
      roleCategory: "cybersecurity",
      signalType: "new_job",
      score: 65,
      scoreVersion: "v1",
      detectedAt: "2026-07-28T00:00:00Z",
      headline: "New Cybersecurity role posted",
      summary: "A new Cybersecurity position was posted.",
    });
    expect(id).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("INSERT INTO signals");
    expect(calls[0]?.params).toEqual([
      id,
      "c1",
      "cybersecurity",
      "new_job",
      65,
      "v1",
      "2026-07-28T00:00:00Z",
      "2026-07-28T00:00:00Z",
      "New Cybersecurity role posted",
      "A new Cybersecurity position was posted.",
    ]);
  });
});

describe("refreshSignal", () => {
  it("updates score/score_version/last_detected_at only, keyed by signal id", async () => {
    const { client, calls } = createFakeClient();
    await refreshSignal(client, "sig-1", {
      score: 80,
      scoreVersion: "v1",
      lastDetectedAt: "2026-07-28T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("UPDATE signals SET score = ?, score_version = ?, last_detected_at = ?");
    expect(calls[0]?.params).toEqual([80, "v1", "2026-07-28T00:00:00Z", "sig-1"]);
  });
});

describe("appendSignalEvidence", () => {
  it("serializes payload to JSON and inserts one row", async () => {
    const { client, calls } = createFakeClient();
    const payload = { score: 72, components: { freshness: 1.0 }, formulaVersion: "v1" };
    const id = await appendSignalEvidence(client, {
      signalId: "sig-1",
      jobId: "job-1",
      evidenceType: "new_job_posting",
      observedAt: "2026-07-28T00:00:00Z",
      payload,
    });
    expect(id).toBeTruthy();
    expect(calls[0]?.sql).toContain("INSERT INTO signal_evidence");
    expect(calls[0]?.params).toEqual([
      id,
      "sig-1",
      "job-1",
      "new_job_posting",
      "2026-07-28T00:00:00Z",
      JSON.stringify(payload),
    ]);
  });

  it("allows a null jobId (evidence not tied to a specific job)", async () => {
    const { client, calls } = createFakeClient();
    await appendSignalEvidence(client, {
      signalId: "sig-1",
      jobId: null,
      evidenceType: "new_job_posting",
      observedAt: "2026-07-28T00:00:00Z",
      payload: {},
    });
    expect(calls[0]?.params[2]).toBeNull();
  });
});
