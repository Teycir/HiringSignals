import { inferLocationMode as _inferLocationMode } from "../../../lib/text/location-mode";
import type { LocationMode } from "@hiring-signals/domain";

// Thin re-export/delegate: domain types own LocationMode (the source of
// truth for enum values); lib/text/location-mode.ts owns the generic
// inference function. This file is kept so adapter callers can import from
// "@hiring-signals/adapters" -- not from the repo-local lib/ folder -- and
// because the domain LocationMode type happens to be a superset that
// matches the lib's inferred string union exactly. If the taxonomy ever
// diverges, change the cast here, not in lib/.
export function inferLocationMode(raw: string | null | undefined): LocationMode {
  return _inferLocationMode(raw) as LocationMode;
}
export type { LocationMode };
