"use client";

import { SIGNAL_TYPES } from "@hiring-signals/domain";
import type { SignalType } from "@hiring-signals/domain";
import { Button } from "./ui/button";

/** Display labels for signal types (spec 7.1). Same rationale as
 * role-filter.tsx's ROLE_LABELS. */
const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  new_job: "New job",
  reopened_job: "Reopened job",
  hiring_burst: "Hiring burst",
  role_acceleration: "Role acceleration",
  multi_location: "Multi-location",
  persistent_demand: "Persistent demand",
};

interface SignalTypeFilterProps {
  /** Single-select: FilterState.signalType is `SignalType | undefined`. */
  value: SignalType | undefined;
  onChange: (next: SignalType | undefined) => void;
  // No facets prop: Facets (@hiring-signals/db/src/types) has no
  // `signalTypes` entry -- only roles/sources/locationModes are
  // faceted today, so unlike role-filter/work-mode-filter/source-filter
  // this one can't show counts. Add a `signalTypes: FacetCount[]` facet
  // (packages/db) first if counts are wanted here later.
}

export function SignalTypeFilter({ value, onChange }: SignalTypeFilterProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Signal type</legend>
      <div aria-label="Signal type" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value === undefined ? "primary" : "secondary"}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className="px-3 py-2 text-xs"
        >
          Any
        </Button>
        {SIGNAL_TYPES.map((type) => (
          <Button
            key={type}
            type="button"
            variant={value === type ? "primary" : "secondary"}
            aria-pressed={value === type}
            onClick={() => onChange(type)}
            className="px-3 py-2 text-xs"
          >
            {SIGNAL_TYPE_LABELS[type]}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
