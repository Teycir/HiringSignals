import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import {
  createD1Client,
  getFacets,
  readFacetsSnapshot,
  readFacetsSnapshotMirror,
} from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";

export const facetsRoute = new Hono<AppEnv>();
facetsRoute.use("*", freeReadTier());

const CACHE_KEY = "facets:v1";
const CACHE_TTL_SECONDS = 60;

// Role/company/source/location counts for the filter rail (spec 9.2, 10.4).
// Cached in KV with a short TTL; ingestion doesn't explicitly invalidate
// this yet (spec 15) so a stale-for-up-to-60s facet count is an accepted
// tradeoff until the ingestion consumer lands and can purge the key.
facetsRoute.get("/", async (c) => {
  // Cache read with graceful fallback (2026-09-02 prod incident, same
  // reasoning as trends.ts's own .get() fix -- this call had the same
  // gap the 2026-08-19 KV-quota fix only closed for .put() calls).
  let cached: unknown = null;
  try {
    cached = await c.env.CACHE.get(CACHE_KEY, "json");
  } catch (err) {
    console.error(`KV cache read failed for key ${CACHE_KEY}:`, err);
  }
  if (cached) {
    return c.json({ data: cached, meta: { requestId: c.get("requestId"), cached: true } });
  }

  const client = createD1Client(c.env.DB);

  // D1-outage fallback (read-path-hardening-plan.md §4.4): getFacets
  // previously had no fallback beyond the 60s KV cache above, which
  // itself gets exhausted under a sustained D1 outage (same
  // "sometimes it appears sometimes not" symptom the signal-detail/
  // company-detail routes had). Falls back to the daily-cron-captured
  // facets snapshot (packages/db/src/snapshot-repo.ts, written by
  // reconciliation.ts's handleSnapshotCapture -- never on request
  // traffic), same D1 snapshot -> KV mirror chain GET /api/v1/signals
  // already uses for its own default-feed snapshot.
  let facets;
  let servedFromSnapshot = false;
  let snapshotCapturedAt: string | null = null;
  try {
    facets = await getFacets(client);
  } catch (err) {
    console.error("D1 query failed for facets (falling back to snapshot):", err);

    let snapshot;
    try {
      snapshot = await readFacetsSnapshot(client);
    } catch (snapshotErr) {
      console.error("Snapshot fallback also failed for facets, trying KV mirror:", snapshotErr);
      snapshot = await readFacetsSnapshotMirror(c.env.CACHE);
    }
    // No snapshot to fall back to (reconciliation hasn't run once since
    // deploy) -- rethrow and let errorHandler's generic 500 apply, same
    // as the other hardened routes' "genuinely nothing to serve" case.
    if (!snapshot) throw err;

    facets = snapshot.payload.facets;
    servedFromSnapshot = true;
    snapshotCapturedAt = snapshot.capturedAt;
  }

  // Cache write with graceful fallback for KV quota limits (free tier
  // has a daily write limit) -- if exceeded, still return the fresh result
  // rather than failing the entire request. Skipped when serving from
  // the snapshot fallback: D1 has already proven unreachable this
  // request, and re-caching a stale snapshot under the live cache key
  // would mask the outage from the next request instead of retrying D1.
  if (!servedFromSnapshot) {
    try {
      await c.env.CACHE.put(CACHE_KEY, JSON.stringify(facets), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (err) {
      console.error(`KV cache write failed for key ${CACHE_KEY}:`, err);
    }
  }

  return c.json({
    data: facets,
    meta: {
      requestId: c.get("requestId"),
      cached: false,
      // Same meaning as the other hardened routes: true when the live
      // D1 read failed and this response was served from the
      // daily-captured facets snapshot instead.
      servedFromSnapshot,
      snapshotCapturedAt,
    },
  });
});
