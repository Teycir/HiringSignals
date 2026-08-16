"use client";

import { Button } from "./ui/button";

/**
 * Preset score thresholds (spec 10.4: "0-100 range / preset
 * thresholds" -- an explicit either/or). Presets chosen over a
 * continuous slider: no range/slider primitive exists yet in
 * components/ui, and every other F.4 filter (role-filter,
 * company-combobox) is discrete-choice, not continuous-drag --
 * a slider would be the one outlier interaction pattern in the
 * filter rail. Threshold values themselves aren't spec'd; 40/60/80
 * are a reasonable low/medium/high split of the 0-100 scoring range
 * used elsewhere (e.g. spec's own minScore=60 URL example).
 */
const SCORE_PRESETS = [40, 60, 80] as const;

interface ScoreFilterProps {
  /** Current minScore, or undefined for "any score" (spec 10.4 default:
   * unset). Mirrors FilterState["minScore"] exactly -- parent passes
   * this straight through to/from lib/searchParams.ts. */
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}

export function ScoreFilter({ value, onChange }: ScoreFilterProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Score</legend>
      {/* Toggle buttons, not role="radio": each stays natively
          Tab-focusable and aria-pressed communicates selection without
          implying arrow-key roving-tabindex support this group doesn't
          implement (a real radiogroup role without that support is a
          worse screen-reader experience than no role at all). */}
      <div aria-label="Minimum score" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value === undefined ? "primary" : "secondary"}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className="px-3 py-2 text-xs"
        >
          Any
        </Button>
        {SCORE_PRESETS.map((threshold) => (
          <Button
            key={threshold}
            type="button"
            variant={value === threshold ? "primary" : "secondary"}
            aria-pressed={value === threshold}
            onClick={() => onChange(threshold)}
            className="px-3 py-2 text-xs"
          >
            {threshold}+
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
