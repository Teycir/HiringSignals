import { defineCommand } from "citty";
import { fetchFacets, resolveConfig } from "../api-client";
import { printResult, renderTable, type TableColumn } from "../output";
import type { Facets, FacetCount } from "@hiring-signals/db/src/types";

const FACET_COLUMNS: TableColumn<FacetCount>[] = [
  { header: "VALUE", value: (f) => f.value },
  { header: "COUNT", value: (f) => String(f.count) },
];

/** Facets has three independent arrays (roles/sources/locationModes),
 * not one flat list -- rendered as three small labeled tables rather
 * than concatenating them into one table with a spurious "kind" column,
 * since that would blur three unrelated facets into one misleading
 * ranking. */
function renderFacetsTable(result: { data: Facets }): string {
  return [
    "ROLES:",
    renderTable(result.data.roles, FACET_COLUMNS),
    "",
    "SOURCES:",
    renderTable(result.data.sources, FACET_COLUMNS),
    "",
    "LOCATION MODES:",
    renderTable(result.data.locationModes, FACET_COLUMNS),
  ].join("\n");
}

/** `hs facets` -- GET /api/v1/facets (spec 9.2, 10.4). Leaf command, no
 * subcommands or flags: the route itself takes none. */
export const facetsCommand = defineCommand({
  meta: { name: "facets", description: "Available filter facets (roles, sources, location modes)." },
  async run() {
    const result = await fetchFacets(resolveConfig());
    printResult(result, renderFacetsTable);
  },
});
