"use client";

import { ATS_PROVIDERS } from "@hiring-signals/domain";
import type { AtsProvider } from "@hiring-signals/domain";
import type { Facets } from "@hiring-signals/db/src/types";
import { PROVIDER_LABELS } from "@/lib/labels";
import { Button } from "./ui/button";
import { DataLabel } from "./ui/data-label";

interface SourceFilterProps {
  /** Single-select: FilterState.source is `AtsProvider | undefined`. */
  value: AtsProvider | undefined;
  onChange: (next: AtsProvider | undefined) => void;
  /** Counts from fetchFacets(). Only providers with a nonzero facet
   * count are rendered as options -- ATS_PROVIDERS includes 3 deferred
   * adapters (teamtailor/jazzhr/bamboohr per ROADMAP) that will never
   * have signals to filter by until those adapters ship, so listing
   * them here would be dead, always-empty options. Falls back to
   * showing nothing but "Any" until facets load. */
  facets?: Facets;
}

export function SourceFilter({ value, onChange, facets }: SourceFilterProps) {
  const countByProvider = new Map<string, number>();
  if (facets) {
    for (const entry of facets.sources) {
      countByProvider.set(entry.value, entry.count);
    }
  }

  const available = ATS_PROVIDERS.filter((p) => countByProvider.has(p));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Source</legend>
      <div aria-label="Source provider" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value === undefined ? "primary" : "secondary"}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className="px-3 py-2 text-xs"
        >
          Any
        </Button>
        {available.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant={value === provider ? "primary" : "secondary"}
            aria-pressed={value === provider}
            onClick={() => onChange(provider)}
            className="px-3 py-2 text-xs gap-1.5"
          >
            {PROVIDER_LABELS[provider]}
            <DataLabel className="ml-1">{countByProvider.get(provider)}</DataLabel>
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
