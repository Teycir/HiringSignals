"use client";

import { ROLE_CATEGORIES, type RoleCategory } from "@hiring-signals/domain";
import type { Facets } from "@hiring-signals/db/src/types";
import { ROLE_LABELS } from "@/lib/labels";
import { Checkbox } from "./ui/checkbox";
import { DataLabel } from "./ui/data-label";

interface RoleFilterProps {
  /** Currently selected role categories (multi-select, OR within group --
   * spec 10.4: "Selected roles compose with OR"). */
  selected: RoleCategory[];
  onChange: (next: RoleCategory[]) => void;
  /** Active-signal counts per role, from fetchFacets(). Optional so the
   * filter still renders (without counts) before facets have loaded --
   * spec 10.4 says "include counts," not "block rendering on counts." */
  facets?: Facets;
}

export function RoleFilter({ selected, onChange, facets }: RoleFilterProps) {
  const countByRole = new Map<string, number>();
  if (facets) {
    for (const entry of facets.roles) {
      countByRole.set(entry.value, entry.count);
    }
  }

  function toggle(role: RoleCategory) {
    if (selected.includes(role)) {
      onChange(selected.filter((r) => r !== role));
    } else {
      onChange([...selected, role]);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-display text-sm font-bold uppercase">Role</legend>
      {ROLE_CATEGORIES.map((role) => {
        const count = countByRole.get(role);
        return (
          <div key={role} className="flex items-center justify-between gap-2">
            <Checkbox
              label={ROLE_LABELS[role]}
              checked={selected.includes(role)}
              onChange={() => toggle(role)}
            />
            {count !== undefined && <DataLabel>{count}</DataLabel>}
          </div>
        );
      })}
    </fieldset>
  );
}
