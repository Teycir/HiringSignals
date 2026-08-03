"use client";

import { ROLE_CATEGORIES, type RoleCategory } from "@hiring-signals/domain";
import type { Facets } from "@hiring-signals/db/src/types";
import { Checkbox } from "./ui/checkbox";
import { DataLabel } from "./ui/data-label";

/**
 * Human-readable labels for the canonical P0 role taxonomy (spec 6.1).
 * No display-label mapping exists anywhere else in the codebase yet --
 * ROLE_CATEGORIES (@hiring-signals/domain) is snake_case, machine-facing
 * only. Kept here rather than in @hiring-signals/domain since this is
 * the only place in the app that currently needs human-readable role
 * names; promote it to a shared location if a second consumer appears
 * (e.g. signal-card.tsx's role category display).
 */
const ROLE_LABELS: Record<RoleCategory, string> = {
  software_engineering: "Software Engineering",
  data_engineering_analytics: "Data Engineering & Analytics",
  cloud_platform_devops_sre: "Cloud / Platform / DevOps / SRE",
  cybersecurity: "Cybersecurity",
  it_support_help_desk: "IT Support / Help Desk",
  systems_network_administration: "Systems & Network Administration",
  qa_test_automation: "QA / Test Automation",
  product_technical_program_management: "Product / Technical Program Mgmt",
  erp_business_systems: "ERP / Business Systems",
  ai_machine_learning: "AI / Machine Learning",
};

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
