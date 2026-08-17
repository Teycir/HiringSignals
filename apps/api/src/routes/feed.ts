import { Hono } from "hono";
import { z } from "zod";
import { atsProviderSchema, roleCategorySchema, signalTypeSchema } from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import { createD1Client, listSignalsForFeed, type SignalExportRow } from "@hiring-signals/db";
import { buildRssFeed, type RssFeedItem } from "../../../../lib/text/rss";
import { computeContentHash } from "../../../../lib/text/content-hash";
import { freeReadTier } from "../middleware/anti-abuse";

/**
 * Milestone R.2 (ROADMAP.md), closing the "notify me later" gap
 * identified 2026-08-06 -- an RSS feed delivers push-style alerts via
 * any feed reader with no accounts, no personal data, no new
 * infrastructure. Not gated on apps/cli (Milestone F.1): a feed URL's
 * query params are short enough to construct by hand or template, so
 * this route has no CLI dependency, only R.1 (the serializer).
 *
 * Query schema: same field set and reasoning as export.ts's own
 * exportQuerySchema (own inline z.object, not signalsQuerySchema minus
 * fields) -- a route's contract should be legible on its own without
 * needing to open signals.ts to see what's accepted, same convention
 * both places. ROADMAP.md's prose for this route used shorthand names
 * (`role`, `workMode`, `since`) that don't match the real wire contract
 * signals.ts/export.ts actually enforce (`roles`, `locationMode`,
 * `observedSince`) -- this schema matches the real one, like export.ts
 * does, not the prose sketch.
 */
const feedQuerySchema = z.object({
  // `.min(1)` bug fix -- same hand-copy-didn't-inherit-the-fix issue as
  // export.ts's exportQuerySchema (see that file's identical comment
  // and signals-query.ts's signalsQuerySchema.roles for the original
  // fix). Without this, `?roles=` or `?roles=,` on this route silently
  // parsed as `[]` (== "no filter" to listSignalsForFeed's shared
  // buildCommonFilters), AND buildChannelTitle's `parsed.roles.length >
  // 0` guard below would silently omit the role from the feed's own
  // <title> too -- a caller who mistyped --role would get an unfiltered
  // feed titled as if no role was ever requested, with no error either
  // place to explain why.
  roles: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(roleCategorySchema).min(1))
    .optional(),
  company: z.string().optional(),
  q: z.string().min(2).optional(),
  locationMode: z.enum(["remote", "hybrid", "onsite", "unknown"]).optional(),
  country: z
    .string()
    .length(2)
    .transform((code) => code.toUpperCase())
    .optional(),
  source: atsProviderSchema.optional(),
  signalType: signalTypeSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  observedSince: z.string().datetime({ offset: true }).optional(),
});

function toFeedItem(row: SignalExportRow): RssFeedItem {
  return {
    signal_id: row.id,
    headline: row.headline,
    summary: row.summary,
    score: row.score,
    signal_type: row.signal_type,
    canonical_url: row.canonical_url,
    first_detected_at: row.first_detected_at,
  };
}

/**
 * Channel <title> built from active filter params (spec's own mockup:
 * "Hiring Signals — backend · london"). Only the two most identity-
 * bearing filters (roles, country) are folded in -- the rest
 * (minScore, source, signalType, q) still narrow the actual result set
 * but would make the title unreadable if all were concatenated; the
 * full filter set is always visible in the feed URL itself, which is
 * the source of truth for what's applied, same as the query string is
 * for signals.ts's own `meta.appliedFilters` echo.
 */
function buildChannelTitle(parsed: z.infer<typeof feedQuerySchema>): string {
  const parts: string[] = [];
  if (parsed.roles && parsed.roles.length > 0) {
    parts.push(parsed.roles.join("/"));
  }
  if (parsed.country) {
    parts.push(parsed.country);
  }
  return parts.length > 0 ? `Hiring Signals — ${parts.join(" · ")}` : "Hiring Signals";
}

export const feedRoute = new Hono<AppEnv>();
feedRoute.use("*", freeReadTier());

feedRoute.get("/feed.rss", async (c) => {
  const parsed = feedQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  const result = await listSignalsForFeed(client, {
    roles: parsed.roles,
    company: parsed.company,
    q: parsed.q,
    locationMode: parsed.locationMode,
    country: parsed.country,
    source: parsed.source,
    signalType: parsed.signalType,
    minScore: parsed.minScore,
    observedSince: parsed.observedSince,
  });

  const items = result.items.map(toFeedItem);
  const lastBuildDate = items[0]?.first_detected_at ?? new Date().toISOString();

  const xml = buildRssFeed(items, {
    selfUrl: c.req.url,
    title: buildChannelTitle(parsed),
    description: "Live, evidence-backed hiring signals from HiringSignals.",
    lastBuildDate,
  });

  // ETag over the rendered document itself -- content-hash.ts's helper
  // takes a stable-key-order object, not a raw string, so we wrap the
  // XML in a single-field object; simplest way to reuse the existing
  // helper without adding a string-hashing variant for one caller.
  const etag = `"${await computeContentHash({ xml })}"`;
  const ifNoneMatch = c.req.header("If-None-Match");

  c.header("Content-Type", "application/rss+xml; charset=utf-8");
  c.header("Cache-Control", "no-store");
  c.header("Last-Modified", new Date(lastBuildDate).toUTCString());
  c.header("ETag", etag);
  if (result.truncated) {
    c.header("X-Feed-Truncated", "true");
  }

  if (ifNoneMatch === etag) {
    return c.body(null, 304);
  }

  return c.body(xml);
});
