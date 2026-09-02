import { describe, expect, it } from "vitest";
import { buildTrendsCacheKey, buildTrendsFallbackCacheKey, resolveTrendsSince } from "../../src/routes/trends";

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

  it("defaults to 7 days before now when since is omitted", () => {
    expect(resolveTrendsSince({}, now)).toBe("2026-08-02T12:00:00.000Z");
  });

  it("passes through an explicit since value unchanged", () => {
    expect(resolveTrendsSince({ since: "2026-01-01T00:00:00.000Z" }, now)).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  /**
   * 2026-09-02 fix: the default branch rounds down to a
   * CACHE_TTL_SECONDS (300s) boundary so that buildTrendsCacheKey/
   * buildTrendsFallbackCacheKey produce the same key for every request
   * within the same 5-minute bucket -- otherwise every request computes
   * a distinct `since` (millisecond precision) and both the hot cache
   * and the D1-outage fallback never hit. These two `now` values are
   * seconds apart but fall in the same 12:05-12:10 UTC bucket, so they
   * must resolve to the identical `since` -- that equality is the whole
   * point of the fix, not just each value individually being "close".
   */
  it("resolves the identical since for two now values in the same 5-minute bucket", () => {
    const first = resolveTrendsSince({}, new Date("2026-08-09T12:05:00.000Z"));
    const second = resolveTrendsSince({}, new Date("2026-08-09T12:09:59.999Z"));
    expect(first).toBe("2026-08-02T12:05:00.000Z");
    expect(second).toBe(first);
  });

  it("resolves a different since once now crosses into the next 5-minute bucket", () => {
    const inBucket = resolveTrendsSince({}, new Date("2026-08-09T12:09:59.999Z"));
    const nextBucket = resolveTrendsSince({}, new Date("2026-08-09T12:10:00.000Z"));
    expect(nextBucket).toBe("2026-08-02T12:10:00.000Z");
    expect(nextBucket).not.toBe(inBucket);
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

/**
 * D1-outage "last known good" fallback (2026-09-02 incident, see
 * trends.ts's own header comment on buildTrendsFallbackCacheKey): this
 * key must never collide with buildTrendsCacheKey's hot-cache key for
 * the same params (different KV entries, different lifetimes -- the
 * hot cache expires in 300s, the fallback never does), and must still
 * vary per param combination the same way the hot-cache key does, or
 * two different filter selections would silently share one another's
 * stale fallback data.
 */
describe("buildTrendsFallbackCacheKey", () => {
  it("differs from buildTrendsCacheKey for the same params", () => {
    const params = { roles: ["ai_machine_learning"], sort: "acceleration_desc", limit: 20 };
    const since = "2026-07-10T12:00:00.000Z";
    expect(buildTrendsFallbackCacheKey(params, since)).not.toBe(buildTrendsCacheKey(params, since));
  });

  it("produces different keys for different param combinations", () => {
    const base = { roles: ["ai_machine_learning"], sort: "acceleration_desc", limit: 20 };
    const keyA = buildTrendsFallbackCacheKey(base, "2026-07-10T12:00:00.000Z");
    const keyB = buildTrendsFallbackCacheKey({ ...base, industry: "fintech" }, "2026-07-10T12:00:00.000Z");
    expect(keyA).not.toBe(keyB);
  });
});
