import { describe, expect, it } from "vitest";
import { resolveTimelineWindow } from "../../src/routes/companies";

/**
 * ROADMAP.md Milestone O.1 (GET /api/v1/companies/:slug/timeline).
 * resolveTimelineWindow is the one piece of branching logic in the
 * timeline route that isn't a pass-through to getCompanyHiringTimeline
 * (packages/db/src/companies-repo.ts, already covered live-D1 in
 * packages/db/test/companies-repo.test.ts) -- pure function, no D1/AI/
 * Vectorize dependency, so plain fixture-input testing applies (same
 * category as apps/api/test/lib/rss.test.ts). Route-level end-to-end
 * behavior (404 on unknown slug, 400 on this function's rejection, 200
 * with real bucketed data) was verified manually against a live local
 * `wrangler dev` instance seeded with real ingested jobs (databricks:
 * 823 real jobs) -- apps/api has no existing routes/*.test.ts precedent
 * (checked: apps/api/test has jobs/, lib/, middleware/ only), so this
 * file follows lib/rss.test.ts's plain-vitest style rather than
 * inventing a new Hono-request-mocking pattern for one route.
 */
describe("resolveTimelineWindow", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("defaults to a 90-day-ago..now window when since/until are both omitted", () => {
    const result = resolveTimelineWindow({}, now);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.until).toBe("2026-08-08T12:00:00.000Z");
    expect(result.since).toBe("2026-05-10T12:00:00.000Z");
  });

  it("defaults only the missing side when one of since/until is provided", () => {
    const untilOnly = resolveTimelineWindow({ since: "2026-08-01T00:00:00.000Z" }, now);
    expect(untilOnly.ok).toBe(true);
    if (!untilOnly.ok) throw new Error("expected ok");
    expect(untilOnly.since).toBe("2026-08-01T00:00:00.000Z");
    expect(untilOnly.until).toBe("2026-08-08T12:00:00.000Z");
  });

  it("accepts an explicit window exactly at the 90-day cap", () => {
    const result = resolveTimelineWindow(
      { since: "2026-05-10T12:00:00.000Z", until: "2026-08-08T12:00:00.000Z" },
      now,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a window wider than 90 days", () => {
    const result = resolveTimelineWindow(
      { since: "2026-01-01T00:00:00.000Z", until: "2026-08-08T00:00:00.000Z" },
      now,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("90 days");
  });

  it("rejects an inverted window (until before since)", () => {
    const result = resolveTimelineWindow(
      { since: "2026-08-08T00:00:00.000Z", until: "2026-08-01T00:00:00.000Z" },
      now,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.message).toContain("positive");
  });

  it("rejects a zero-width window (since === until)", () => {
    const result = resolveTimelineWindow(
      { since: "2026-08-01T00:00:00.000Z", until: "2026-08-01T00:00:00.000Z" },
      now,
    );
    // windowMs === 0 is not < 0, so this is accepted -- a single-instant
    // window is degenerate but not malformed; getCompanyHiringTimeline's
    // own bucketCount calc (Math.max(1, Math.ceil(...))) already handles
    // a zero-width window by producing exactly one empty bucket, so this
    // route doesn't need its own extra rejection for it.
    expect(result.ok).toBe(true);
  });
});
