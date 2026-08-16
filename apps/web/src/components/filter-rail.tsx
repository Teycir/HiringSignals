"use client";

import type { Facets } from "@hiring-signals/db/src/types";
import type { FilterState } from "@/lib/searchParams";
import { RoleFilter } from "./role-filter";
import { CompanyCombobox } from "./company-combobox";
import { ScoreFilter } from "./score-filter";
import { WorkModeFilter } from "./work-mode-filter";
import { SourceFilter } from "./source-filter";
import { SignalTypeFilter } from "./signal-type-filter";
import { SinceFilter } from "./since-filter";

/**
 * Composes every P0 filter (spec 10.4) into the filter rail slotted into
 * AppShell's `filters` prop. Purely presentational/controlled -- takes
 * the current FilterState and a single onChange, and does not fetch
 * `facets` itself (the parent /signals page owns that one fetchFacets()
 * call and passes the result down, since role-filter/work-mode-filter/
 * source-filter all read from the same Facets object -- fetching it once
 * here rather than duplicating the request per-child).
 *
 * Each child filter keeps its own field-specific value/onChange contract
 * (RoleFilter's array, ScoreFilter's number|undefined, etc.) rather than
 * this component re-deriving a generic "any filter changed" handler --
 * that keeps each leaf filter testable/usable in isolation (as
 * role-filter.tsx and score-filter.tsx already are), with only this file
 * knowing how the individual fields fold into one FilterState update.
 */
interface FilterRailProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  facets?: Facets;
}

export function FilterRail({ filters, onChange, facets }: FilterRailProps) {
  return (
    <div className="flex flex-col gap-6">
      <RoleFilter
        selected={filters.roles}
        onChange={(roles) => onChange({ ...filters, roles })}
        facets={facets}
      />
      <CompanyCombobox
        selectedSlug={filters.company}
        onSelect={(company) => onChange({ ...filters, company: company?.slug })}
      />
      <ScoreFilter
        value={filters.minScore}
        onChange={(minScore) => onChange({ ...filters, minScore })}
      />
      <WorkModeFilter
        value={filters.locationMode}
        onChange={(locationMode) => onChange({ ...filters, locationMode })}
        facets={facets}
      />
      <SourceFilter
        value={filters.source}
        onChange={(source) => onChange({ ...filters, source })}
        facets={facets}
      />
      <SignalTypeFilter
        value={filters.signalType}
        onChange={(signalType) => onChange({ ...filters, signalType })}
      />
      <SinceFilter
        value={filters.since}
        onChange={(since) => onChange({ ...filters, since })}
      />
    </div>
  );
}
