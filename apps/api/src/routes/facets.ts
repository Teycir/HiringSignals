import { Hono } from "hono";
import type { AppEnv } from "../bindings";

export const facetsRoute = new Hono<AppEnv>();

// Role/company/source/location counts for the filter rail (spec 9.2, 10.4).
// Phase 1 backs this with a KV-cached aggregate query, invalidated after
// successful ingestion batches (spec 15 implementation tactics).
facetsRoute.get("/", (c) => {
  return c.json({
    data: {
      roles: [],
      sources: [],
      locationModes: [],
    },
    meta: { requestId: c.get("requestId") },
  });
});
