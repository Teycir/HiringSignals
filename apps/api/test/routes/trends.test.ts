import { describe, expect, it } from "vitest";
import { mergeTrendSnapshots, sortTrendCompanies } from "../../src/routes/trends";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";

/**
 * ROADMAP.md Milestone P.2 (GET /api/v1/trends/hiring), rewritten per
 * snapshot-persistence-plan.md to read snapshots_current instead of a
 * live D1 query behind a KV cache/fallback pair. The route's only
 * branching logic is now mergeTrendSnapshots (dedupe a company across
 * multiple requested roles' snapshot rows, apply industry/country
 * filters in-process) and sortTrendCompanies (same ranking semantics
 * trends-repo.ts's getHiringTrends already applies at capture time,
 * reapplied here over the merged snapshot rows) -- both pure functions,
 * no D1/KV dependency, so plain fixture-input testing applies, same
 * category and file style as apps/api/test/routes/companies.test.ts's
 * own resolveTimelineWindow tests (superseded here: resolveTrendsSince/
 * buildTrendsCacheKey/buildTrendsFallbackCacheKey no longer exist --
 * this route never touches D1/KV on the request path at all, see
 * trends.ts's own header comment and handleSnapshotCapture in
 * apps/api/src/jobs/reconciliation.ts for where the snapshot is
 * actually computed).
 */

function makeCompany(overrides: Partial<HiringTrendCompany> = {}): HiringTrendCompany {
  return {
    company: {
      slug: "acme",
      displayName: "Acme",
      industry: "fintech",
      domain: "acme.example",
    },
    newJobsCount: 1,
    activeJobsCount: 1,
    acceleration: 0,
    topLocations: [{ countryCode: "US", count: 1 }],
    latestSignalType: null,
    latestSignalAt: null,
    hiringVelocityScore: null,
    ...overrides,
  };
}

function makeSnapshotsByRole(
  entries: Array<[string, HiringTrendCompany[], string]>,
): Map<string, { payload: { companies: HiringTrendCompany[] }; capturedAt: string }> {
  const map = new Map<string, { payload: { companies: HiringTrendCompany[] }; capturedAt: string }>();
  for (const [role, companies, capturedAt] of entries) {
    map.set(role, { payload: { companies }, capturedAt });
  }
  return map;
}

describe("mergeTrendSnapshots", () => {
  it("returns companies from a single role's snapshot unfiltered", () => {
    const a = makeCompany({ company: { slug: "a", displayName: "A", industry: "fintech", domain: null } });
    const b = makeCompany({ company: { slug: "b", displayName: "B", industry: "healthtech", domain: null } });
    const snapshots = makeSnapshotsByRole([["ai_machine_learning", [a, b], "2026-09-01T00:00:00.000Z"]]);

    const result = mergeTrendSnapshots(snapshots, {});

    expect(result.map((r) => r.company.slug).sort()).toEqual(["a", "b"]);
  });

  it("dedupes a company appearing under multiple requested roles, keeping the higher newJobsCount row", () => {
    const lowVersion = makeCompany({
      company: { slug: "acme", displayName: "Acme", industry: "fintech", domain: null },
      newJobsCount: 2,
    });
    const highVersion = makeCompany({
      company: { slug: "acme", displayName: "Acme", industry: "fintech", domain: null },
      newJobsCount: 9,
    });
    const snapshots = makeSnapshotsByRole([
      ["ai_machine_learning", [lowVersion], "2026-09-01T00:00:00.000Z"],
      ["cybersecurity", [highVersion], "2026-09-01T01:00:00.000Z"],
    ]);

    const result = mergeTrendSnapshots(snapshots, {});

    expect(result).toHaveLength(1);
    expect(result[0]!.newJobsCount).toBe(9);
  });

  it("filters out companies not matching industryFilter", () => {
    const fintech = makeCompany({
      company: { slug: "fin-co", displayName: "Fin Co", industry: "fintech", domain: null },
    });
    const health = makeCompany({
      company: { slug: "health-co", displayName: "Health Co", industry: "healthtech", domain: null },
    });
    const snapshots = makeSnapshotsByRole([
      ["ai_machine_learning", [fintech, health], "2026-09-01T00:00:00.000Z"],
    ]);

    const result = mergeTrendSnapshots(snapshots, { industryFilter: "fintech" });

    expect(result.map((r) => r.company.slug)).toEqual(["fin-co"]);
  });

  it("filters out companies whose topLocations don't include countryFilter", () => {
    const usCo = makeCompany({
      company: { slug: "us-co", displayName: "US Co", industry: "fintech", domain: null },
      topLocations: [{ countryCode: "US", count: 3 }],
    });
    const deCo = makeCompany({
      company: { slug: "de-co", displayName: "DE Co", industry: "fintech", domain: null },
      topLocations: [{ countryCode: "DE", count: 2 }],
    });
    const snapshots = makeSnapshotsByRole([
      ["ai_machine_learning", [usCo, deCo], "2026-09-01T00:00:00.000Z"],
    ]);

    const result = mergeTrendSnapshots(snapshots, { countryFilter: "DE" });

    expect(result.map((r) => r.company.slug)).toEqual(["de-co"]);
  });
});

describe("sortTrendCompanies", () => {
  const high = makeCompany({
    company: { slug: "high", displayName: "High", industry: "fintech", domain: null },
    newJobsCount: 10,
    acceleration: 5,
    hiringVelocityScore: 90,
  });
  const low = makeCompany({
    company: { slug: "low", displayName: "Low", industry: "fintech", domain: null },
    newJobsCount: 2,
    acceleration: 1,
    hiringVelocityScore: 10,
  });
  const uncomputed = makeCompany({
    company: { slug: "uncomputed", displayName: "Uncomputed", industry: "fintech", domain: null },
    newJobsCount: 1,
    acceleration: 0,
    hiringVelocityScore: null,
  });

  it("volume_desc sorts by newJobsCount descending", () => {
    const result = sortTrendCompanies([low, high], "volume_desc");
    expect(result.map((r) => r.company.slug)).toEqual(["high", "low"]);
  });

  it("acceleration_desc sorts by acceleration descending", () => {
    const result = sortTrendCompanies([low, high], "acceleration_desc");
    expect(result.map((r) => r.company.slug)).toEqual(["high", "low"]);
  });

  it("velocity_desc sorts by hiringVelocityScore descending, null (uncomputed) last", () => {
    const result = sortTrendCompanies([uncomputed, low, high], "velocity_desc");
    expect(result.map((r) => r.company.slug)).toEqual(["high", "low", "uncomputed"]);
  });

  it("does not mutate the input array", () => {
    const input = [low, high];
    const copy = [...input];
    sortTrendCompanies(input, "volume_desc");
    expect(input).toEqual(copy);
  });
});
