"use client";

import { locationModeSchema } from "@hiring-signals/domain";
import type { LocationMode } from "@hiring-signals/domain";
import type { Facets } from "@hiring-signals/db/src/types";
import { Button } from "./ui/button";
import { DataLabel } from "./ui/data-label";

const LOCATION_MODES = locationModeSchema.options;

const LOCATION_MODE_LABELS: Record<LocationMode, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "Onsite",
  unknown: "Unknown",
};

interface WorkModeFilterProps {
  /** Single-select (unlike role-filter's multi-select): FilterState.
   * locationMode is `LocationMode | undefined`, not an array -- spec
   * 10.4 doesn't say explicitly, but the singular field shape in
   * lib/searchParams.ts is the actual contract this follows. */
  value: LocationMode | undefined;
  onChange: (next: LocationMode | undefined) => void;
  /** Counts from fetchFacets(); optional so the filter renders before
   * facets load (same rationale as role-filter.tsx). */
  facets?: Facets;
}

export function WorkModeFilter({ value, onChange, facets }: WorkModeFilterProps) {
  const countByMode = new Map<string, number>();
  if (facets) {
    for (const entry of facets.locationModes) {
      countByMode.set(entry.value, entry.count);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Work mode</legend>
      <div aria-label="Work mode" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value === undefined ? "primary" : "secondary"}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className="px-3 py-2 text-xs"
        >
          Any
        </Button>
        {LOCATION_MODES.map((mode) => {
          const count = countByMode.get(mode);
          return (
            <Button
              key={mode}
              type="button"
              variant={value === mode ? "primary" : "secondary"}
              aria-pressed={value === mode}
              onClick={() => onChange(mode)}
              className="px-3 py-2 text-xs gap-1.5"
            >
              {LOCATION_MODE_LABELS[mode]}
              {count !== undefined && <DataLabel className="ml-1">{count}</DataLabel>}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
