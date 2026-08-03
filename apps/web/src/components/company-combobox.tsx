"use client";

import { useEffect, useRef, useState } from "react";
import type { CompanySummary } from "@hiring-signals/db/src/types";
import { fetchCompanies, isAbortError } from "../lib/api-client";
import { useDebouncedValue } from "../lib/use-debounced-value";
import { Input } from "./ui/input";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

interface CompanyComboboxProps {
  /** Canonical slug of the currently selected company, if any (spec
   * 10.4: "Selecting a company uses its canonical slug in the URL"). */
  selectedSlug?: string;
  onSelect: (company: CompanySummary | undefined) => void;
}

/**
 * Typeahead starting after 2 characters, ~250ms debounce (spec 12.2),
 * searches company display name/alias/domain (server-side, via
 * fetchCompanies -- this component doesn't implement the search logic
 * itself). Single-company only in MVP (spec 10.4): selecting an option
 * replaces any prior selection rather than adding to a list; there's no
 * multi-select affordance to build here.
 *
 * The debounce itself lives in useDebouncedValue (lib/), not inline here,
 * so it's reusable outside this one component (e.g. Milestone I.4's
 * free-text search). The fetch-with-cancellation logic below stays
 * inline rather than becoming its own hook -- it's tightly coupled to
 * "debounced query -> fetchCompanies -> options list," a shape specific
 * enough to this component that extracting it now would be speculative;
 * promote it if a second typeahead-style consumer appears.
 */
export function CompanyCombobox({ selectedSlug, onSelect }: CompanyComboboxProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CompanySummary[]>([]);
  // Loading is derived, not a separately-set boolean: a fetch is "in
  // flight" exactly when the debounced query has changed since the last
  // one we resolved (react-hooks' set-state-in-effect rule flags calling
  // setState synchronously at the top of an effect body, e.g.
  // `setIsLoading(true)` right before the fetch call -- tracking a
  // "resolved-for" marker and comparing it against the current debounced
  // query avoids that entirely, since isLoading becomes a plain
  // expression rather than its own state slice).
  const [resolvedForQuery, setResolvedForQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  const abortRef = useRef<AbortController | null>(null);

  const isBelowMinLength = debouncedQuery.trim().length < MIN_QUERY_LENGTH;
  const isLoading = !isBelowMinLength && resolvedForQuery !== debouncedQuery;

  useEffect(() => {
    // Cancel whatever's in flight before starting a new request -- a
    // fast typist can otherwise get a slow earlier response landing
    // after a faster later one and overwriting it with stale options
    // (spec 12.2 step 5's "cancel stale client requests," applied here
    // to typeahead rather than the main feed).
    abortRef.current?.abort();

    // Below the 2-char minimum, or already resolved for this exact query
    // (e.g. handleSelect just set resolvedForQuery to match a selection,
    // and the debounce timer is now catching up to the same value) --
    // skip the fetch. isBelowMinLength/isLoading (derived above, not
    // stored) already gate the rendered UI correctly in both cases.
    if (isBelowMinLength || resolvedForQuery === debouncedQuery) return;

    const controller = new AbortController();
    abortRef.current = controller;

    fetchCompanies({ q: debouncedQuery, limit: 10 }, { signal: controller.signal })
      .then((res) => {
        setOptions(res.data);
        setResolvedForQuery(debouncedQuery);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setOptions([]);
        setResolvedForQuery(debouncedQuery);
      });

    return () => controller.abort();
  }, [debouncedQuery, isBelowMinLength, resolvedForQuery]);

  function handleSelect(company: CompanySummary) {
    onSelect(company);
    setQuery(company.displayName);
    setOptions([]);
    // Mark the selected name as already "resolved" so the debounce timer
    // firing ~250ms later (query still lags debouncedQuery by design)
    // doesn't re-trigger a spurious search-in-progress state/refetch
    // against the name we just picked.
    setResolvedForQuery(company.displayName);
  }

  function handleClear() {
    onSelect(undefined);
    setQuery("");
    setOptions([]);
    setResolvedForQuery("");
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        label="Company"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or domain..."
        autoComplete="off"
      />
      {selectedSlug && (
        <button
          type="button"
          onClick={handleClear}
          className="font-display text-sm text-left underline"
        >
          Clear selected company
        </button>
      )}
      {isLoading && !isBelowMinLength && <p className="data-label">Searching...</p>}
      {!isBelowMinLength && options.length > 0 && (
        <ul className="border-2 border-ink flex flex-col">
          {options.map((company) => (
            <li key={company.id}>
              <button
                type="button"
                onClick={() => handleSelect(company)}
                className="w-full text-left px-3 py-2 font-display hover:bg-accent hover:text-ink"
              >
                {company.displayName}
                {company.domain && (
                  <span className="data-label ml-2 text-soft-ink">{company.domain}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
