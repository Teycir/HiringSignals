/**
 * Deterministic location-mode inference from a free-text location string
 * (e.g. as found on job postings, event listings, or store locators).
 *
 * Checks "hybrid" before "remote" so a string matching both terms (e.g.
 * "Hybrid - Remote optional") resolves to the more specific "hybrid"
 * rather than the first pattern that happens to match.
 *
 * A missing or empty string resolves to "unknown", never a guessed
 * default -- treat absence of data as unknown, not as a claim (e.g. don't
 * default a blank field to "onsite" just because that's the most common
 * case; that silently fabricates information you don't have).
 *
 * Zero project-specific dependencies -- copy this file into any project
 * that needs to classify a free-text location field.
 */

export type LocationMode = "remote" | "hybrid" | "onsite" | "unknown";

const REMOTE_PATTERN = /\bremote\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;

export function inferLocationMode(raw: string | null | undefined): LocationMode {
  if (!raw || raw.trim().length === 0) return "unknown";
  if (HYBRID_PATTERN.test(raw)) return "hybrid";
  if (REMOTE_PATTERN.test(raw)) return "remote";
  return "onsite";
}
