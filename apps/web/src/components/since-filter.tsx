"use client";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Mirrors lib/searchParams.ts's SINCE_PRESETS -- not imported directly
 * since that file doesn't export the array, only the derived type. Kept
 * in sync by hand; if this drifts, isCustomDateString/SINCE_PRESETS in
 * searchParams.ts is the source of truth to check against. */
const SINCE_PRESETS = ["24h", "7d", "30d"] as const;
type SincePreset = (typeof SINCE_PRESETS)[number];

const PRESET_LABELS: Record<SincePreset, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};

function isPreset(value: string): value is SincePreset {
  return (SINCE_PRESETS as readonly string[]).includes(value);
}

function isCustomDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

interface SinceFilterProps {
  /** Mirrors FilterState["since"]: a preset keyword, a YYYY-MM-DD
   * custom date, or undefined for no filter. Presets and custom date
   * are mutually exclusive -- picking one clears the other, since the
   * underlying field holds exactly one value either way. */
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}

export function SinceFilter({ value, onChange }: SinceFilterProps) {
  const activePreset = value && isPreset(value) ? value : undefined;
  const customDate = value && isCustomDateString(value) ? value : "";

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Observed</legend>
      <div aria-label="Observed since" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value === undefined ? "primary" : "secondary"}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className="px-3 py-2 text-xs"
        >
          Any
        </Button>
        {SINCE_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            variant={activePreset === preset ? "primary" : "secondary"}
            aria-pressed={activePreset === preset}
            onClick={() => onChange(preset)}
            className="px-3 py-2 text-xs"
          >
            {PRESET_LABELS[preset]}
          </Button>
        ))}
      </div>
      <Input
        type="date"
        label="Custom date"
        value={customDate}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="text-xs"
      />
    </fieldset>
  );
}
