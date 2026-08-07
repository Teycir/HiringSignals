import { defineCommand } from "citty";
import { fetchFacets, resolveConfig } from "../api-client";

/** `hs facets` -- GET /api/v1/facets (spec 9.2, 10.4). Leaf command, no
 * subcommands or flags: the route itself takes none. */
export const facetsCommand = defineCommand({
  meta: { name: "facets", description: "Available filter facets (roles, sources, location modes)." },
  async run() {
    const result = await fetchFacets(resolveConfig());
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});
