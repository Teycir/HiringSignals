/**
 * Tests for apps/api/src/middleware/api-metrics.ts's normalizeRoutePath --
 * the one piece of branching logic in this middleware (spec §16.3 "API
 * error rates"), same "pure function, no D1/AI/Vectorize/KV dependency"
 * category as companies.test.ts's resolveTimelineWindow and
 * admin-auth.test.ts's timingSafeEqualStrings (AGENTS.md's zero-mocks
 * policy applies to Cloudflare resources, not to plain pure functions --
 * this needs neither a live binding nor a fake one).
 *
 * The middleware's own writeDataPoint call is NOT covered by an
 * automated test here, though it DOES run under local `wrangler dev`
 * (verified live, 2026-08-11: env.API_METRICS reports Mode: local under
 * this repo's wrangler 4.114.0, and writeDataPoint completed without
 * throwing across three real requests -- see api-metrics.ts's header
 * comment for the full account). The gap is tooling, not the resource:
 * cloudflareTest()/vitest-pool-workers has no assertion surface for
 * "what data point did Analytics Engine receive" the way it does for
 * D1 (query it back) or KV (get the key) -- Analytics Engine is
 * write-only from inside the Worker and only queryable back out via the
 * separate production SQL API (see infrastructure/scripts for that
 * pattern), so there's nothing to assert against in a test run. The
 * binding-presence guard and its own try/catch (see api-metrics.ts's
 * header comment) are the safety net for the write path itself, checked
 * by live wrangler dev + code review, not by a vitest assertion.
 */
import { describe, expect, it } from "vitest";
import { normalizeRoutePath } from "../../src/middleware/api-metrics";

describe("normalizeRoutePath", () => {
  it("collapses a signal UUID into :id", () => {
    expect(normalizeRoutePath("/api/v1/signals/869ca429-a383-5a49-9f3e-52b4858cb06a")).toBe(
      "/api/v1/signals/:id",
    );
  });

  it("collapses a company slug into :param", () => {
    expect(normalizeRoutePath("/api/v1/companies/harbor-fintech")).toBe(
      "/api/v1/companies/:param",
    );
  });

  it("keeps the timeline suffix as a static segment after the slug param", () => {
    expect(normalizeRoutePath("/api/v1/companies/harbor-fintech/timeline")).toBe(
      "/api/v1/companies/:param/timeline",
    );
  });

  it("leaves a plain list route (no params) unchanged", () => {
    expect(normalizeRoutePath("/api/v1/signals")).toBe("/api/v1/signals");
    expect(normalizeRoutePath("/api/v1/sources")).toBe("/api/v1/sources");
    expect(normalizeRoutePath("/api/v1/facets")).toBe("/api/v1/facets");
  });

  it("keeps export's literal .csv filename static, not a param", () => {
    expect(normalizeRoutePath("/api/v1/export/signals.csv")).toBe("/api/v1/export/signals.csv");
  });

  it("keeps feed's literal .rss filename static, not a param", () => {
    expect(normalizeRoutePath("/api/v1/feed.rss")).toBe("/api/v1/feed.rss");
  });

  it("keeps trends hiring's static path unchanged", () => {
    expect(normalizeRoutePath("/api/v1/trends/hiring")).toBe("/api/v1/trends/hiring");
  });

  it("collapses admin's :sourceId UUID into :id, keeping run static", () => {
    expect(
      normalizeRoutePath("/api/v1/admin/sources/5de57831-c09d-4c94-9469-e05907b1d101/run"),
    ).toBe("/api/v1/admin/sources/:id/run");
  });

  it("keeps admin's scheduler/flush and reconcile paths unchanged", () => {
    expect(normalizeRoutePath("/api/v1/admin/scheduler/flush")).toBe(
      "/api/v1/admin/scheduler/flush",
    );
    expect(normalizeRoutePath("/api/v1/admin/reconcile")).toBe("/api/v1/admin/reconcile");
  });

  it("is case-insensitive for UUID detection (uppercase hex still matches)", () => {
    expect(normalizeRoutePath("/api/v1/signals/869CA429-A383-5A49-9F3E-52B4858CB06A")).toBe(
      "/api/v1/signals/:id",
    );
  });

  it("treats a malformed near-UUID (wrong segment length) as a slug-shaped :param, not :id", () => {
    // One character short in the last group -- must not false-positive
    // as a UUID, since that would misclassify a genuinely malformed
    // signalId path param the same way a real one is classified, which
    // would defeat the entire point of keeping the two cardinality
    // buckets separate.
    expect(normalizeRoutePath("/api/v1/signals/869ca429-a383-5a49-9f3e-52b4858cb06")).toBe(
      "/api/v1/signals/:param",
    );
  });

  it("handles the root health check path", () => {
    expect(normalizeRoutePath("/api/v1/health")).toBe("/api/v1/health");
  });
});
