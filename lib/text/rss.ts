/**
 * Minimal RSS 2.0 XML serializer for the hiring-signal feed (Milestone
 * R.1, ROADMAP.md; spec's "notify me later" gap identified 2026-08-06).
 * No external dependency -- same reasoning as the sibling `csv.ts`: a
 * flat, fixed-shape document with no nested/streaming requirements is
 * less surface area hand-rolled than pulling in a full RSS/XML library
 * for one route.
 *
 * Row type note: the ROADMAP.md sketch for this function used
 * `SignalListItem[]`, but R.2 (the route that calls this) reuses
 * `listSignalsForExport` -- the same read path `export.ts`'s CSV route
 * already calls -- so the real row shape flowing in here is
 * `SignalExportRow` (`packages/db`'s alias for `SignalRow`), which is
 * what this file actually types against. Field names below
 * (`first_detected_at`/`last_detected_at`) are `SignalRow`'s actual
 * column names, not the `first_seen_at`/`last_seen_at` shorthand used
 * in ROADMAP.md's prose.
 *
 * `packages/db` is intentionally not imported here (this file lives
 * under repo-root `lib/`, outside any workspace package, same as
 * `csv.ts`) -- the caller passes in only the plain fields this function
 * needs, so `rss.ts` has zero dependency on `packages/db`'s types and
 * stays a pure function of its inputs.
 */

export interface RssFeedItem {
  signal_id: string;
  headline: string;
  summary: string;
  score: number;
  signal_type: string;
  canonical_url: string | null;
  first_detected_at: string;
}

export interface RssFeedMeta {
  selfUrl: string;
  title: string;
  description: string;
  lastBuildDate: string;
}

/** Escapes the five XML predefined entities. Applied to every text node
 * and attribute value this module writes -- headline/summary are
 * user-influenced (job-board content), so nothing here is trusted. */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** RFC 822 date format required by RSS 2.0's `<pubDate>`/`<lastBuildDate>`
 * (e.g. "Fri, 07 Aug 2026 12:00:00 GMT"). `Date#toUTCString()` already
 * produces exactly this format in both V8 (Workers/Node) and every other
 * major engine -- no manual formatting needed. Throws on an invalid
 * input string via `Date`'s own NaN-on-invalid behavior surfacing as
 * "Invalid Date" -- callers are expected to pass valid ISO-8601
 * `first_detected_at`/`last_detected_at` values straight from D1, which
 * are never malformed at that point in the pipeline.
 */
function toRfc822(isoDate: string): string {
  return new Date(isoDate).toUTCString();
}

function buildItem(item: RssFeedItem): string {
  const link = item.canonical_url ?? "";
  const description = `${item.summary} (score: ${item.score}, type: ${item.signal_type})`;
  return [
    "    <item>",
    `      <title>${escapeXml(item.headline)}</title>`,
    link ? `      <link>${escapeXml(link)}</link>` : "",
    `      <guid isPermaLink="false">${escapeXml(item.signal_id)}</guid>`,
    `      <pubDate>${toRfc822(item.first_detected_at)}</pubDate>`,
    `      <description>${escapeXml(description)}</description>`,
    "    </item>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds a complete RSS 2.0 document. Empty `items` produces a valid
 * feed with zero `<item>` elements (a feed reader polling a filter combo
 * with no current matches should see "no items," not an error) -- in
 * that case `lastBuildDate` falls back to `meta.lastBuildDate` as
 * supplied by the caller (R.2 passes the current time when the query
 * result set is empty).
 */
export function buildRssFeed(items: RssFeedItem[], meta: RssFeedMeta): string {
  const itemsXml = items.map(buildItem).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.selfUrl)}</link>`,
    `    <description>${escapeXml(meta.description)}</description>`,
    `    <lastBuildDate>${toRfc822(meta.lastBuildDate)}</lastBuildDate>`,
    itemsXml,
    "  </channel>",
    "</rss>",
  ]
    .filter(Boolean)
    .join("\n");
}
