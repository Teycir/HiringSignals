import type { LocationMode } from "@hiring-signals/domain";

/**
 * Shared, deterministic location-mode inference used by every adapter's
 * normalize() (spec 5.3). Adapters pass whatever free-text location field
 * their provider exposes; this never guesses "onsite" from absence alone,
 * since a missing field is unknown, not a claim (spec 5.3: "treat missing
 * dates as unknown, not as current" applies to location too).
 */
const REMOTE_PATTERN = /\bremote\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;

export function inferLocationMode(raw: string | null | undefined): LocationMode {
  if (!raw || raw.trim().length === 0) return "unknown";
  if (HYBRID_PATTERN.test(raw)) return "hybrid";
  if (REMOTE_PATTERN.test(raw)) return "remote";
  return "onsite";
}
