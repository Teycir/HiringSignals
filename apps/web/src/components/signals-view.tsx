"use client";
// The actual /signals content (spec 10.2, 12.2 steps 1/2/4): ties
// FilterRail + SignalFeed + lib/searchParams.ts together. Owns exactly
// what filter-rail.tsx/signal-feed.tsx's own comments say they
// deliberately don't: parsing the URL into FilterState (step 1),
// fetching facets once and passing them down (filter-rail.tsx's
// comment: "does not fetch facets itself... the parent /signals page
// owns that one fetchFacets() call"), and syncing FilterState changes
// back to the URL (step 4, via serializeFilterState).
//
// Client component, not a server component with searchParams prop: the
// filter rail is fully interactive (checkboxes/toggles firing onChange
// synchronously) and FilterState needs to live in client state that's
// kept in sync with the URL bidirectionally, not just read once at
// render time the way a server component's searchParams prop would.
//
// Lives in components/, not app/signals/page.tsx, because it calls
// useSearchParams() -- Next requires that hook's nearest client
// component to sit inside a <Suspense> boundary (CSR bail-out during
// static generation), so app/signals/page.tsx stays a thin server
// component that only renders <Suspense><SignalsView /></Suspense>;
// putting useSearchParams() directly in page.tsx would put the
// Suspense boundary above the very component that needs it, which
// doesn't satisfy the requirement.
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Facets } from "@hiring-signals/db/src/types";
import { AppShell } from "@/components/app-shell";
import { FilterRail } from "@/components/filter-rail";
import { SearchBar } from "@/components/search-bar";
import { SignalFeed } from "@/components/signal-feed";
import { fetchFacets } from "@/lib/api-client";
import { parseFilterState, serializeFilterState, type FilterState } from "@/lib/searchParams";

export function SignalsView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // FilterState is derived fresh from the URL on every render (step 1) --
  // the URL is the single source of truth, not a separately-tracked
  // client state that could drift from it. onChange (below) writes to
  // the URL via router.replace, which re-renders this page with the new
  // searchParams, which re-derives `filters` -- one-directional data
  // flow, no dual state to keep in sync by hand.
  const filters = parseFilterState(searchParams);

  function handleFiltersChange(next: FilterState) {
    const params = serializeFilterState(next);
    // replace, not push: filter changes are refinements of the same
    // view, not new navigation history entries -- matches
    // company-combobox.tsx/score-filter.tsx's existing controlled
    // pattern of "every keystroke/click is a live update," not
    // something a user would expect to step back through one filter
    // change at a time via the browser back button.
    router.replace(`/signals?${params.toString()}`, { scroll: false });
  }

  function handleResetFilters() {
    router.replace("/signals", { scroll: false });
  }

  // Facets fetched once here, passed down to FilterRail (which passes
  // them to RoleFilter/WorkModeFilter/SourceFilter) -- not re-fetched on
  // every filter change, since facet counts (available roles/sources/
  // locationModes) don't depend on the *current* filter selection in
  // this API (fetchFacets() takes no params -- see api-client.ts).
  const [facets, setFacets] = useState<Facets | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchFacets()
      .then((res) => {
        if (!cancelled) setFacets(res.data);
      })
      .catch(() => {
        // Facets are progressive enhancement (counts next to each filter
        // option) -- FilterRail's children already render without them
        // (facets is an optional prop throughout), so a failed facets
        // fetch degrades to filters-without-counts rather than blocking
        // the page or showing an error for a non-critical request.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell
      filters={<FilterRail filters={filters} onChange={handleFiltersChange} facets={facets} />}
    >
      <div className="p-4 md:p-6 flex flex-col gap-4">
        {/* Milestone I.4, spec 9.4: free-text hybrid search bar. Wired to
            the same filters/handleFiltersChange the filter rail already
            uses -- SearchBar only ever touches FilterState.q, so a
            search and a filter change compose naturally (both funnel
            through this one onChange -> URL -> SignalFeed refetch
            pipeline). */}
        <SearchBar filters={filters} onChange={handleFiltersChange} />
        <SignalFeed filters={filters} onResetFilters={handleResetFilters} />
      </div>
    </AppShell>
  );
}
