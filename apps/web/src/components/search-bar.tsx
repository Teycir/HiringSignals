"use client";
// Free-text hybrid search bar (Milestone I.4, spec 9.4). Ported from
// ArxivExplorer's SearchBoxHome.tsx + RecentSearches.tsx -- UX mechanics
// only (controlled input -> debounced URL write, localStorage recent-
// list dropdown), restyled from scratch against spec 11 tokens, no
// Tailwind classes copied verbatim (ROADMAP's explicit instruction).
//
// Wired to the SAME FilterState/onChange signals-view.tsx already
// threads through FilterRail -- `q` is not a new concept, searchParams.ts's
// FilterState/toApiParams/serializeFilterState already carry it end to
// end (built during Milestone I.3's backend work). This component's only
// job is giving that existing field a UI.
//
// Debounced at 250ms, the same convention spec 12.2 sets for
// company-combobox's free-text search (use-debounced-value.ts's header
// comment already anticipated this exact reuse) -- keeps a fast typist
// from firing a Workers AI embedding call on every keystroke while still
// feeling live.
import { useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "@/lib/searchHistory";
import type { FilterState } from "@/lib/searchParams";
import { DataLabel } from "./ui/data-label";

const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

interface SearchBarProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

export function SearchBar({ filters, onChange }: SearchBarProps) {
  const [rawQuery, setRawQuery] = useState(filters.q ?? "");
  const [isFocused, setIsFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // Tracks the last value THIS component wrote into FilterState, so the
  // resync effect below can tell "the URL changed underneath us" (Reset
  // filters, MoreLikeThisButton navigation, browser back/forward) apart
  // from "the debounce effect below just committed what the user typed"
  // -- without this the two effects fight over rawQuery.
  const lastCommitted = useRef(filters.q ?? "");
  const debouncedQuery = useDebouncedValue(rawQuery, DEBOUNCE_MS);

  useEffect(() => {
    const urlQuery = filters.q ?? "";
    if (urlQuery !== lastCommitted.current) {
      lastCommitted.current = urlQuery;
      setRawQuery(urlQuery);
    }
  }, [filters.q]);

  // Debounced commit: writes the settled value into FilterState/URL
  // (spec 9.3's `q` param, min 2 chars server-side -- shorter input
  // clears the filter rather than sending a query the API would reject).
  // Includes `filters`/`onChange` in deps (same tolerance signal-feed.tsx's
  // own effect already has for a fresh FilterState object every render)
  // -- the `next === lastCommitted.current` guard bails before calling
  // onChange again, so extra effect re-runs from a changing object
  // reference are harmless, not a bug.
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    const next = trimmed.length >= MIN_QUERY_LENGTH ? trimmed : "";
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    onChange({ ...filters, q: next || undefined });
    if (next) addRecentSearch(next);
  }, [debouncedQuery, filters, onChange]);

  // Bypasses the debounce for an explicit action (Enter key, clicking a
  // recent search, the clear button) -- these are deliberate commits,
  // not mid-typing keystrokes, so there's no reason to wait 250ms.
  function commitImmediately(value: string) {
    const trimmed = value.trim();
    setRawQuery(trimmed);
    lastCommitted.current = trimmed;
    onChange({ ...filters, q: trimmed || undefined });
    if (trimmed) addRecentSearch(trimmed);
    setRecent(getRecentSearches());
  }

  function handleFocus() {
    setIsFocused(true);
    setRecent(getRecentSearches());
  }

  function handleClearRecent() {
    clearRecentSearches();
    setRecent([]);
  }

  // Recent-search suggestions only make sense before the user has typed
  // anything for this visit -- once rawQuery has content, the dropdown
  // would just be noise competing with what they're already typing.
  const showRecent = isFocused && rawQuery.trim().length === 0 && recent.length > 0;

  return (
    <div className="relative flex flex-col gap-1 w-full max-w-xl">
      <label
        htmlFor="signal-search"
        className="font-display text-sm font-bold uppercase tracking-wide"
      >
        Search
      </label>
      <div className="relative">
        <input
          id="signal-search"
          type="text"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onFocus={handleFocus}
          onBlur={() => setIsFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitImmediately(rawQuery);
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Try: remote rust backend, hybrid platform engineer..."
          autoComplete="off"
          className="w-full bg-paper text-ink border-2 border-ink px-3 py-2 pr-9 font-display"
        />
        {rawQuery && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitImmediately("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 font-display font-bold text-lg leading-none text-soft-ink hover:text-ink"
          >
            &times;
          </button>
        )}
      </div>

      {showRecent && (
        // Dropdown item buttons use onMouseDown/preventDefault (not just
        // onClick) so the input's onBlur -- which fires before a click's
        // own onClick on most browsers -- doesn't close this dropdown
        // out from under the click, same technique company-combobox.tsx's
        // sibling typeahead would need for the same reason.
        <ul className="absolute top-full left-0 right-0 mt-1 bg-paper border-2 border-ink z-10 flex flex-col">
          <li className="px-3 py-2 flex items-center justify-between border-b-2 border-ink">
            <DataLabel className="text-soft-ink">Recent searches</DataLabel>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClearRecent}
              className="data-label underline text-soft-ink hover:text-ink"
            >
              Clear
            </button>
          </li>
          {recent.map((entry) => (
            <li key={entry}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitImmediately(entry)}
                className="w-full text-left px-3 py-2 font-display text-sm hover:bg-accent hover:text-ink"
              >
                {entry}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
