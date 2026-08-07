import type { D1Client } from "./d1-client";

// FacetCount/Facets moved to ./types.ts so type-only consumers
// don't pull in D1Client -- see that file's header comment.
export type { FacetCount, Facets } from "./types";
import type { Facets } from "./types";

/**
 * Aggregate counts for the filter rail (spec 9.2, 10.4). Counts active
 * signals by role_category, and active jobs by provider/location_mode.
 * Phase 1: caller (route) is expected to cache this behind KV with a short
 * TTL, invalidated after successful ingestion batches (spec 15).
 */
export async function getFacets(client: D1Client): Promise<Facets> {
  const [roleRows, sourceRows, locationRows] = await client.batch<{ value: string; count: number }>(
    [
      {
        sql: `SELECT role_category AS value, COUNT(*) AS count
            FROM signals WHERE status = 'active'
            GROUP BY role_category ORDER BY count DESC`,
      },
      {
        sql: `SELECT s.provider AS value, COUNT(*) AS count
            FROM jobs j JOIN sources s ON s.id = j.source_id
            WHERE j.status = 'active'
            GROUP BY s.provider ORDER BY count DESC`,
      },
      {
        sql: `SELECT location_mode AS value, COUNT(*) AS count
            FROM jobs WHERE status = 'active'
            GROUP BY location_mode ORDER BY count DESC`,
      },
    ],
  );

  return {
    roles: roleRows ?? [],
    sources: sourceRows ?? [],
    locationModes: locationRows ?? [],
  };
}
