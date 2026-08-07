import { describe, expect, it } from "vitest";
import { buildRssFeed, type RssFeedItem, type RssFeedMeta } from "../../../../lib/text/rss";

const baseMeta: RssFeedMeta = {
  selfUrl: "https://hiring-signals-api.example.workers.dev/api/v1/feed.rss?role=backend",
  title: "Hiring Signals — backend",
  description: "Live hiring signals for backend",
  lastBuildDate: "2026-08-07T12:00:00.000Z",
};

function item(overrides: Partial<RssFeedItem> = {}): RssFeedItem {
  return {
    signal_id: "sig_1",
    headline: "Acme Corp is hiring backend engineers",
    summary: "3 new roles posted in the last 14 days",
    score: 82,
    signal_type: "hiring_burst",
    canonical_url: "https://acme.example/jobs/123",
    first_detected_at: "2026-08-07T09:30:00.000Z",
    ...overrides,
  };
}

describe("buildRssFeed", () => {
  it("produces valid RSS 2.0 shell with channel metadata", () => {
    const xml = buildRssFeed([], baseMeta);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<title>Hiring Signals — backend</title>");
    expect(xml).toContain(
      "<link>https://hiring-signals-api.example.workers.dev/api/v1/feed.rss?role=backend</link>",
    );
    expect(xml).toContain("</rss>");
  });

  it("empty feed has zero <item> elements but is still valid", () => {
    const xml = buildRssFeed([], baseMeta);
    expect(xml).not.toContain("<item>");
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</channel>");
  });

  it("formats pubDate/lastBuildDate as RFC 822", () => {
    const xml = buildRssFeed([item()], baseMeta);
    expect(xml).toMatch(/<lastBuildDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/lastBuildDate>/);
    expect(xml).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  });

  it("HTML/XML-escapes headline, summary, and link", () => {
    const xml = buildRssFeed(
      [
        item({
          headline: `Roles at "R&D" <Team>`,
          summary: `Growth & scale — 5 new "senior" roles`,
        }),
      ],
      baseMeta,
    );
    expect(xml).toContain("&quot;R&amp;D&quot; &lt;Team&gt;");
    expect(xml).toContain("Growth &amp; scale");
    expect(xml).not.toContain('"R&D"');
    expect(xml).not.toContain("<Team>");
  });

  it("guid is isPermaLink=false and unique per item", () => {
    const xml = buildRssFeed(
      [item({ signal_id: "sig_1" }), item({ signal_id: "sig_2" })],
      baseMeta,
    );
    expect(xml).toContain('<guid isPermaLink="false">sig_1</guid>');
    expect(xml).toContain('<guid isPermaLink="false">sig_2</guid>');
    const guidMatches = xml.match(/<guid isPermaLink="false">/g) ?? [];
    expect(guidMatches).toHaveLength(2);
  });

  it("omits <link> when canonical_url is null (company-level aggregate signal)", () => {
    const xml = buildRssFeed([item({ canonical_url: null })], baseMeta);
    const linkMatches = xml.match(/<link>/g) ?? [];
    expect(linkMatches).toHaveLength(1);
  });

  it("description includes score and signal type", () => {
    const xml = buildRssFeed([item({ score: 91, signal_type: "multi_location" })], baseMeta);
    expect(xml).toContain("score: 91");
    expect(xml).toContain("type: multi_location");
  });
});
