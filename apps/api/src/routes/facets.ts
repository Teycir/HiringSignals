import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createD1Client, getFacets } from "@hiring-signals/db";
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
  const facets = await getFacets(client);

  // Cache write with graceful fallback for KV quota limits (free tier
  // has a daily write limit) -- if exceeded, still return the fresh result
  // rather than failing the entire request.
  try {
    await c.env.CACHE.put(CACHE_KEY, JSON.stringify(facets), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.error(`KV cache write failed for key ${CACHE_KEY}:`, err);
  }

  return c.json({ data: facets, meta: { requestId: c.get("requestId"), cached: false } });
});
