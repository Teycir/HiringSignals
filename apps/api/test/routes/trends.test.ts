import { describe, expect, it } from "vitest";
import { buildTrendsCacheKey, resolveTrendsSince } from "../../src/routes/trends";

/**
 * ROADMAP.md Milestone P.2 (GET /api/v1/trends/hiring).
 * resolveTrendsSince/buildTrendsCacheKey are the only branching logic
 * in the trends route that isn't a pass-through to getHiringTrends
 * (packages/db/src/trends-repo.ts, already covered live-D1 in
 * packages/db/test/trends-repo.test.ts's 5 tests: acceleration sort,
 * industry filter, volume sort, topLocations cap, zero-new-jobs
 * exclusion) -- pure functions, no D1/AI/Vectorize/KV dependency, so
 * plain fixture-input testing applies, same category and file style as
 * apps/api/test/routes/companies.test.ts's own resolveTimelineWindow
 * tests.
 */
describe("resolveTrendsSince", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  it("defaults to 30 days before now when since is omitted", () => {
    expect(resolveTrendsSince({}, now)).toBe("2026-07-10T12:00:00.000Z");
  });

  it("passes through an explicit since value unchanged", () => {
    expect(resolveTrendsSince({ since: "2026-01-01T00:00:00.000Z" }, now)).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("buildTrendsCacheKey", () => {
  it("includes every param that affects the result in the key", () => {
    const key = buildTrendsCacheKey(
      { roles: ["ai_machine_learning"], sort: "acceleration_desc", limit: 20 },
      "2026-07-10T12:00:00.000Z",
    );
    expect(key).toBe(
      'trends:v1:{"roles":["ai_machine_learning"],"sort":"acceleration_desc","limit":20,"since":"2026-07-10T12:00:00.000Z"}',
    );
  });

  it("produces different keys for different param combinations", () => {
    const base = { roles: ["ai_machine_learning"], sort: "acceleration_desc", limit: 20 };
    const keyA = buildTrendsCacheKey(base, "2026-07-10T12:00:00.000Z");
    const keyB = buildTrendsCacheKey({ ...base, industry: "fintech" }, "2026-07-10T12:00:00.000Z");
    const keyC = buildTrendsCacheKey(base, "2026-06-01T00:00:00.000Z");
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });
});
