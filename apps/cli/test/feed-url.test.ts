import { describe, expect, it } from "vitest";
import { buildFeedUrl } from "../src/api-client";

/**
 * R.3 (ROADMAP.md): asserts flag-to-query-param mapping matches R.2's
 * accepted param set exactly, so drift between "what hs feed-url builds"
 * and "what GET /api/v1/feed.rss actually accepts" is caught here rather
 * than discovered by a person pasting a broken URL into a feed reader.
 * No network call -- buildFeedUrl is pure string construction (see its
 * own header comment in api-client.ts), so this is plain fixture-input
 * testing, not a case AGENTS.md's zero-mocks-for-Cloudflare-resources
 * policy applies to.
 */

const config = { baseUrl: "http://localhost:8787", adminSecret: undefined };

describe("buildFeedUrl", () => {
  it("with no filters, returns the bare feed.rss path", () => {
    const url = buildFeedUrl(config);
    expect(url).toBe("http://localhost:8787/api/v1/feed.rss");
  });

  it("serializes roles as a comma-joined array, matching feed.ts's roles param", () => {
    const url = buildFeedUrl(config, { roles: ["software_engineering", "cybersecurity"] });
    expect(url).toBe(
      "http://localhost:8787/api/v1/feed.rss?roles=software_engineering%2Ccybersecurity",
    );
  });

  it("includes every filter feed.ts's feedQuerySchema accepts", () => {
    const url = buildFeedUrl(config, {
      roles: ["ai_machine_learning"],
      company: "acme",
      q: "senior backend",
      locationMode: "remote",
      country: "US",
      source: "greenhouse",
      signalType: "hiring_burst",
      minScore: 50,
      observedSince: "2026-08-01T00:00:00Z",
    });
    const parsedQuery = new URL(url).searchParams;
    expect(parsedQuery.get("roles")).toBe("ai_machine_learning");
    expect(parsedQuery.get("company")).toBe("acme");
    expect(parsedQuery.get("q")).toBe("senior backend");
    expect(parsedQuery.get("locationMode")).toBe("remote");
    expect(parsedQuery.get("country")).toBe("US");
    expect(parsedQuery.get("source")).toBe("greenhouse");
    expect(parsedQuery.get("signalType")).toBe("hiring_burst");
    expect(parsedQuery.get("minScore")).toBe("50");
    expect(parsedQuery.get("observedSince")).toBe("2026-08-01T00:00:00Z");
  });

  it("never includes sort/cursor/limit -- feed.rss accepts none of them", () => {
    const url = buildFeedUrl(config, { company: "acme" });
    const parsedQuery = new URL(url).searchParams;
    expect(parsedQuery.has("sort")).toBe(false);
    expect(parsedQuery.has("cursor")).toBe(false);
    expect(parsedQuery.has("limit")).toBe(false);
  });

  it("omits undefined/null filter values entirely rather than an empty param", () => {
    const url = buildFeedUrl(config, { company: undefined, country: undefined });
    expect(url).toBe("http://localhost:8787/api/v1/feed.rss");
  });

  it("uses the configured baseUrl, not a hardcoded host", () => {
    const url = buildFeedUrl(
      { baseUrl: "https://hiring-signals-api.example.workers.dev", adminSecret: undefined },
      { company: "acme" },
    );
    expect(url.startsWith("https://hiring-signals-api.example.workers.dev/api/v1/feed.rss")).toBe(true);
  });
});
