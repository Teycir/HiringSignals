import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createD1Client, getFacets } from "@hiring-signals/db";

export const facetsRoute = new Hono<AppEnv>();

const CACHE_KEY = "facets:v1";
const CACHE_TTL_SECONDS = 60;

// Role/company/source/location counts for the filter rail (spec 9.2, 10.4).
// Cached in KV with a short TTL; ingestion doesn't explicitly invalidate
// this yet (spec 15) so a stale-for-up-to-60s facet count is an accepted
// tradeoff until the ingestion consumer lands and can purge the key.
facetsRoute.get("/", async (c) => {
  const cached = await c.env.CACHE.get(CACHE_KEY, "json");
  if (cached) {
    return c.json({ data: cached, meta: { requestId: c.get("requestId"), cached: true } });
  }

  const client = createD1Client(c.env.DB);
  const facets = await getFacets(client);

  await c.env.CACHE.put(CACHE_KEY, JSON.stringify(facets), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return c.json({ data: facets, meta: { requestId: c.get("requestId"), cached: false } });
});
