/**
 * localStorage-backed recent free-text search history for SearchBar
 * (Milestone I.4, spec 9.4). Ported from ArxivExplorer's
 * RecentSearches.tsx -- UX mechanics only (last-N-queries, most-recent-
 * first, de-duplicated), not styling, per ROADMAP's own "port the
 * shape, restyle from scratch" instruction.
 *
 * Plain functions, no React state/hooks -- same separation as
 * lib/searchParams.ts owning URL (de)serialization while signals-view.tsx
 * decides when to call it: this file owns the storage format, the
 * component decides when to read/write it.
 *
 * SSR-safe: every function checks for `window`/`localStorage` first and
 * no-ops/returns an empty array otherwise, since this module is imported
 * from a "use client" component but Next still evaluates that module
 * during the component's server-rendered first pass.
 */

const STORAGE_KEY = "hiring-signals:recent-searches";
const MAX_ENTRIES = 8;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * Reads the stored list, most-recent-first. Corrupt/missing storage
 * (quota errors, disabled storage, a hand-edited devtools value)
 * degrades to an empty list rather than throwing -- recent searches are
 * a convenience feature, not core functionality, same reasoning as
 * filter-rail.tsx's optional `facets` prop degrading gracefully.
 */
export function getRecentSearches(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Adds `query` to the front of the list, de-duplicated case-insensitively
 * (re-searching "Rust Backend" after "rust backend" moves the existing
 * entry to the top rather than storing both), capped at MAX_ENTRIES.
 * No-ops for a blank query so clearing the search box never writes an
 * empty-string entry.
 */
export function addRecentSearch(query: string): void {
  if (!isBrowser()) return;
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    const existing = getRecentSearches().filter(
      (entry) => entry.toLowerCase() !== trimmed.toLowerCase(),
    );
    const next = [trimmed, ...existing].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full/disabled -- recent searches silently stop persisting
    // rather than breaking the search box itself.
  }
}

/** Clears the stored list (SearchBar's "Clear" affordance next to the
 * recent-searches dropdown). Same silent-degrade rule as above. */
export function clearRecentSearches(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // No-op: nothing to clear if storage was already unavailable.
  }
}
