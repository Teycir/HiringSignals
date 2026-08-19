"use client";
// Signal feed (spec 12.2 steps 3 & 5 -- fetch + cancel stale requests;
// URL parsing/sync, steps 1/2/4, is the /signals page's job, not this
// component's -- same division as company-combobox.tsx not touching
// the URL either). Cursor-based pagination, page-scoped (not
// accumulate-forever "load more"): FilterState.cursor is deliberately
// never round-tripped through the URL (see searchParams.ts's
// serializeFilterState comment -- a new filter combination invalidates
// pagination), so the current page's items plus a cache of visited
// pages live in this component's own state, reset whenever `filters`
// changes. DEFAULT_LIMIT (searchParams.ts) is 15 -- one page's worth,
// not a fetch batch size -- so a page never shows more than 15 signals
// at once, unlike the earlier accumulate-into-one-long-list "Load more"
// behavior.
//
// Numbered page buttons (1 2 3...), not just Previous/Next: since this
// API has no stable row offset to page by (see above), "jump to page N"
// isn't a single request -- it's fetched by walking forward through
// each not-yet-visited page in between and caching every page's items +
// the cursor that produced the *next* one (pageCursors[i] is the cursor
// used to fetch page i+1; pageCursors[0] is always undefined, the
// first-page request has no cursor at all). Once a page has been
// visited, clicking its number re-shows the cached items with no
// refetch. The rendered number range is capped at pages reached so far
// plus one (pageCursors.length + 1) -- higher numbers can't be shown
// or clicked yet because their existence (whether that page has any
// items at all) isn't known until the walk reaches them.
//
// Loading/empty/error states here are functional, not final: spec
// 10.6's exact copy is used for the states this component can support
// today (first load, no-filters-match, API error+retry). The
// "no data yet" / "source stale" states (ROADMAP V.2) are now covered:
// when the feed is empty and no filters are active, fetchSources()
// determines whether the feed is empty because no ingestion has run,
// because sources are stale, or because there genuinely are no signals.
import { useEffect, useRef, useState } from "react";
import type { SignalListItem } from "@hiring-signals/db/src/types";
import { fetchSignals, fetchSources, isAbortError, ApiClientError } from "@/lib/api-client";
import { toApiParams, type FilterState } from "@/lib/searchParams";
import { SignalCard } from "./signal-card";
import { Button } from "./ui/button";

interface SignalFeedProps {
  filters: FilterState;
  onResetFilters: () => void;
}

type FeedState =
  | { status: "error"; error: ApiClientError | Error }
  | { status: "ready"; items: SignalListItem[]; nextCursor: string | null };

/** Returns the most recent lastSuccessAt across all sources, or null if
 * none have ever run. Used to render an honest "no data yet" / "stale"
 * note when the feed is empty and no filters are active (ROADMAP V.2).
 * Field is camelCase to match api-client.ts's SourceSummary (see that
 * file's comment -- this used to read snake_case last_success_at, which
 * never matched the real API response and silently broke this check). */
function latestSuccessAt(sources: { lastSuccessAt: string | null }[]): string | null {
  const times = sources.map((s) => s.lastSuccessAt).filter(Boolean) as string[];
  return times.length > 0 ? times.sort().at(-1) ?? null : null;
}

/** Returns true if no filter that would narrow results is set -- used to
 * decide whether an empty feed means "no data at all" vs "filters too
 * narrow." */
function hasActiveFilters(filters: FilterState): boolean {
  return Boolean(
    filters.roles.length > 0 ||
    filters.company ||
    filters.q ||
    filters.locationMode ||
    filters.country ||
    filters.source ||
    filters.signalType ||
    filters.minScore !== undefined ||
    filters.since,
  );
}

/** One fetched page's worth of cached data -- what pageCache stores per
 * page number, so revisiting an already-fetched page (via a number
 * button or Previous) never refetches. */
interface CachedPage {
  items: SignalListItem[];
  nextCursor: string | null;
}

export function SignalFeed({ filters, onResetFilters }: SignalFeedProps) {
  // No "loading" member in FeedState itself: isLoading is derived below
  // by comparing resolvedForKey against the current filterKey, the same
  // pattern company-combobox.tsx uses (react-hooks/set-state-in-effect
  // flags a synchronous setState at the top of an effect body -- e.g.
  // `setState({ status: "loading" })` right before the fetch call --
  // so loading has to be a plain expression, not its own state value).
  const [state, setState] = useState<FeedState>({
    status: "ready",
    items: [],
    nextCursor: null,
  });
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // pageCursors[i] is the cursor used to *fetch* page i+1 (so
  // pageCursors[0] is always undefined -- the first page's request has
  // no cursor at all). currentPage is 1-indexed. pageCache holds every
  // page's items/nextCursor already fetched this "session" (i.e. since
  // the last filter change), keyed by page number, so clicking a
  // previously-visited number or Previous re-shows cached items with no
  // network request and no loading flash. Both reset to their initial
  // values whenever filters change (new filter combination invalidates
  // any prior page position/cache, same as cursor itself never
  // round-tripping through the URL -- see this file's header comment).
  // Reset happens inline during render (the "adjusting state when a
  // prop changes" pattern React's own docs recommend --
  // react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-
  // when-a-prop-changes), comparing filterKey against the last-seen
  // value stored in state (see lastFilterKey below), NOT in a
  // useEffect: this codebase's own set-state-in-effect lint rule (see
  // the FeedState comment above) flags exactly that shape (a bare
  // setState at the top of an effect body), and this reset is a direct
  // analogue of resetting a component whenever a `key`-like prop
  // changes.
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCache, setPageCache] = useState<Map<number, CachedPage>>(new Map());
  const currentCursor = pageCursors[currentPage - 1];
  // Highest page number known to exist (reached or cached) -- caps the
  // rendered number range at "pages reached so far plus one," since a
  // page beyond that hasn't been fetched yet and might not have any
  // items.
  const maxKnownPage = Math.max(pageCursors.length, ...pageCache.keys(), currentPage);

  // Source staleness state (ROADMAP V.2): fetched once when the feed
  // resolves empty with no active filters. null = not yet fetched.
  const [sourceStatus, setSourceStatus] = useState<
    | null
    | { kind: "never_synced" }
    | { kind: "stale"; lastSyncLabel: string }
    | { kind: "ok" }
  >(null);

  // Base filters (no cursor) as a stable dependency key -- JSON.stringify
  // rather than the FilterState object reference, since a new object
  // with equal contents is created every render by the /signals page
  // (parseFilterState() runs fresh each time) and would otherwise
  // re-trigger this effect on every render, not just on an actual
  // filter change.
  const filterKey = JSON.stringify(toApiParams(filters));

  // Filters changed since the last render (not just a page navigation):
  // reset pagination state back to page 1 and drop the cache (a new
  // filter combination invalidates every cached page's contents),
  // synchronously during render (see the comment on pageCursors above
  // for why this isn't a useEffect). lastFilterKey is plain useState,
  // not useRef: this codebase's lint config (React Compiler-era rules)
  // forbids reading or writing a ref's `.current` during render
  // entirely (refs are for effects/handlers only) -- storing the
  // "previous value to compare against" in state instead is the
  // compiler-safe version of the same "adjusting state when a prop
  // changes" pattern. Initialized to filterKey itself (useState's
  // lazy-init form runs once) so the very first render is never treated
  // as "filters changed."
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    if (pageCursors.length > 1 || currentPage !== 1 || pageCache.size > 0) {
      setPageCursors([undefined]);
      setCurrentPage(1);
      setPageCache(new Map());
    }
  }

  // fetchKey folds currentPage in too, so a page navigation (same
  // filters, different page) is recognized as "not yet resolved" the
  // same way a filter change is -- both go through the one effect below.
  // Deliberately built from filterKey + currentPage as they stand
  // *after* the render-time reset above, so a filter change and its
  // pagination reset are always reflected together, never one render
  // behind the other.
  const fetchKey = `${filterKey}::${currentPage}`;
  const cachedCurrentPage = pageCache.get(currentPage);
  // A cache hit resolves instantly (no fetch, no loading flash) --
  // isLoading only reflects an actual network request in flight.
  const isLoading = cachedCurrentPage === undefined && resolvedForKey !== fetchKey;
  // What to actually render: the cached page's data takes priority over
  // `state` (which only ever reflects the *last network-fetched*
  // result, and lags behind on a cache hit since the effect above does
  // no work for one -- see its comment). Falls back to `state` for the
  // network-fetch and error cases, where there's nothing cached yet.
  const displayState: FeedState =
    cachedCurrentPage !== undefined
      ? { status: "ready", items: cachedCurrentPage.items, nextCursor: cachedCurrentPage.nextCursor }
      : state;

  useEffect(() => {
    if (resolvedForKey === fetchKey) return;
    // Cache hit -- nothing to synchronize with an external system here
    // (no fetch to make), so the effect does nothing. displayState below
    // (derived, not stored) reads straight from pageCache for this case;
    // setting `state` from the cache here would be the same
    // synchronous-setState-in-effect shape this file's lint config
    // already flags elsewhere (see the FeedState comment above) for a
    // value that's entirely derivable without it.
    if (pageCache.has(currentPage)) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetchSignals(
      { ...toApiParams(filters), cursor: currentCursor },
      { signal: controller.signal },
    )
      .then((res) => {
        // Reset source status when we successfully fetch with new filters
        setSourceStatus(null);
        setState({
          status: "ready",
          items: res.data,
          nextCursor: res.meta.nextCursor,
        });
        setPageCache((prev) => {
          const next = new Map(prev);
          next.set(currentPage, { items: res.data, nextCursor: res.meta.nextCursor });
          return next;
        });
        // Record the cursor that reaches the *next* page, so a later
        // Next/number click for currentPage + 1 has it available
        // without needing to re-derive it from cache.
        if (res.meta.nextCursor !== null) {
          setPageCursors((prev) => {
            if (prev[currentPage] === res.meta.nextCursor) return prev;
            const next = [...prev];
            next[currentPage] = res.meta.nextCursor ?? undefined;
            return next;
          });
        }
        setResolvedForKey(fetchKey);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        // Reset source status on error as well
        setSourceStatus(null);
        setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
        setResolvedForKey(fetchKey);
      });

    return () => controller.abort();
  }, [fetchKey, resolvedForKey, filters, currentCursor, currentPage, pageCache]);

  // Primitive stand-ins for the two displayState fields this effect
  // actually reads, so the dependency array below doesn't depend on
  // displayState itself (a fresh object literal every render -- see its
  // definition above -- which would otherwise re-run this effect on
  // every render rather than only when its status or emptiness
  // actually changes).
  const displayStatus = displayState.status;
  const displayItemCount = displayState.status === "ready" ? displayState.items.length : -1;

  // When the feed resolves empty with no active filters, check source
  // staleness once (sourceStatus === null guard prevents re-fetching).
  useEffect(() => {
    if (
      isLoading ||
      displayStatus !== "ready" ||
      displayItemCount !== 0 ||
      hasActiveFilters(filters) ||
      sourceStatus !== null
    ) {
      return;
    }

    fetchSources()
      .then((res) => {
        const latest = latestSuccessAt(res.data);
        if (!latest) {
          setSourceStatus({ kind: "never_synced" });
          return;
        }
        const ageMs = Date.now() - new Date(latest).getTime();
        const ageMinutes = Math.floor(ageMs / 60_000);
        if (ageMinutes > 120) {
          const label =
            ageMinutes < 60
              ? `${ageMinutes}m ago`
              : `${Math.floor(ageMinutes / 60)}h ago`;
          setSourceStatus({ kind: "stale", lastSyncLabel: label });
        } else {
          setSourceStatus({ kind: "ok" });
        }
      })
      .catch((e) => {
        console.error("[SignalFeed] Failed to fetch sources for staleness check:", e);
        setSourceStatus({ kind: "ok" }); // fail open: show plain empty state
      });
  }, [isLoading, displayStatus, displayItemCount, filters, sourceStatus]);

  // goToPage only ever steps to a page whose cursor is already known
  // (cached, or currentPage + 1 once the current page's own fetch
  // returned its nextCursor -- see the effect above writing
  // pageCursors[currentPage]). It does NOT walk multiple uncached pages
  // in one call; the "Next" button and cache hits are what let a user
  // reach page N one step at a time, and the number buttons only ever
  // render for pages within that reached range (see maxKnownPage above
  // and the number-button loop below) -- so a page whose cursor isn't
  // yet known is never clickable in the first place.
  function goToPage(page: number) {
    if (isLoading || page < 1 || page > maxKnownPage) return;
    if (page > currentPage && pageCursors[page - 1] === undefined && page !== 1) {
      // Cursor for this page hasn't been recorded yet -- not reachable
      // in a single step (shouldn't happen given the button range is
      // capped at maxKnownPage, but guards against a stale click).
      return;
    }
    setCurrentPage(page);
  }

  function goToPreviousPage() {
    goToPage(currentPage - 1);
  }

  function goToNextPage() {
    goToPage(currentPage + 1);
  }

  function retry() {
    // Resetting resolvedForKey to something that can't equal the current
    // fetchKey lets the effect's own guard/fetch logic re-run naturally
    // on next render, rather than duplicating the fetch here a third time.
    setResolvedForKey(null);
  }

  // First-load skeleton (spec 10.6: "preserve dense layout", not a
  // generic spinner) only when there's nothing to show yet at all --
  // fixed count of card-shaped placeholders at the same border/padding
  // as SignalCard so the layout doesn't jump once real results arrive.
  // A page *navigation* (Next/Previous/number click) does NOT fall into
  // this branch even while isLoading is true: it falls through to the
  // dimmed-cards branch below instead, which keeps the previous page's
  // cards mounted (same height) rather than swapping to 6 short
  // skeleton blocks -- that swap was shrinking <main>'s height next to
  // AppShell's fixed-width sidebar on every page click, which read as
  // the sidebar "flickering" during reflow even though the sidebar's
  // own markup never changed.
  if (isLoading && displayState.status !== "ready") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading signals">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="border-2 border-ink p-4 h-24 bg-muted animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (displayState.status === "error") {
    // Spec 10.6: "compact error panel with retry, no raw stack trace."
    // ApiClientError.message is server-authored user-facing text (see
    // api-client.ts's apiErrorSchema); a plain Error (network failure,
    // JSON parse failure) gets a generic message instead of its raw
    // message/stack.
    const message =
      displayState.error instanceof ApiClientError
        ? displayState.error.message
        : "Couldn't load signals.";
    return (
      <div className="border-2 border-ink p-4 flex flex-col gap-3">
        <p className="font-display text-sm font-bold">{message}</p>
        <Button type="button" variant="secondary" onClick={retry} className="self-start">
          Retry
        </Button>
      </div>
    );
  }

  if (displayState.status === "ready" && displayState.items.length === 0) {
    // ROADMAP V.2: distinguish "no signals ever" / "sources stale" /
    // "filters too narrow" rather than showing the same message for all
    // three. sourceStatus is null while the staleness check is in flight
    // (immediately after the feed resolves empty) -- show nothing extra
    // until it resolves to avoid a flash of the wrong message.
    if (!hasActiveFilters(filters)) {
      if (sourceStatus === null) {
        // Staleness check still in flight -- show a minimal waiting state.
        return (
          <div className="border-2 border-ink p-6 flex flex-col items-center gap-2 text-center">
            <p className="font-display text-sm font-bold uppercase">No signals yet.</p>
          </div>
        );
      }

      if (sourceStatus.kind === "never_synced") {
        return (
          <div className="border-2 border-ink p-6 flex flex-col items-center gap-2 text-center">
            <p className="font-display text-sm font-bold uppercase">No signals yet.</p>
            <p className="font-display text-sm text-soft-ink">
              No ingestion has run yet — check back after the first scheduled sync.
            </p>
          </div>
        );
      }

      if (sourceStatus.kind === "stale") {
        return (
          <div className="border-2 border-ink p-6 flex flex-col items-center gap-2 text-center">
            <p className="font-display text-sm font-bold uppercase">No signals yet.</p>
            <p className="font-display text-sm text-soft-ink">
              Sources may be stale (last sync: {sourceStatus.lastSyncLabel}). Try again shortly.
            </p>
          </div>
        );
      }
    }

    // Spec 10.6: "NO SIGNALS MATCH THIS QUERY." + RESET FILTERS CTA
    // that clears URL params -- onResetFilters is owned by the /signals
    // page (it knows how to clear the URL), this component just calls it.
    return (
      <div className="border-2 border-ink p-6 flex flex-col items-center gap-3 text-center">
        <p className="font-display text-sm font-bold uppercase">No signals match this query.</p>
        <Button type="button" variant="primary" onClick={onResetFilters}>
          Reset filters
        </Button>
      </div>
    );
  }

  // isLoading here can only mean "navigating to a page not yet cached"
  // (the isLoading && displayState.status !== "ready" branch above
  // already caught the no-data-yet case) -- so displayState.items still
  // holds the previous page's cards (state hasn't been overwritten yet;
  // displayState only swaps to a fetched/cached value once one exists).
  // Dim them rather than swapping to the skeleton: keeps <main>'s
  // height stable during the request, which is what stops the
  // sidebar-adjacent reflow/flicker on Next/Previous/number clicks (see
  // the comment on the skeleton branch above).
  const showsPreviousPageWhileLoading = isLoading && displayState.status === "ready";
  // TypeScript can't narrow displayState.status === "ready" across the
  // early-return branches above (they check it too, but on a different
  // expression), so re-check here for a typed items/nextCursor access
  // below -- this can't actually be false at this point in the render.
  if (displayState.status !== "ready") return null;

  return (
    <div
      className="flex flex-col gap-3"
      aria-busy={showsPreviousPageWhileLoading || undefined}
      style={showsPreviousPageWhileLoading ? { opacity: 0.5 } : undefined}
    >
      {displayState.items.map((signal) => (
        <SignalCard key={signal.id} signal={signal} />
      ))}
      {(maxKnownPage > 1 || displayState.nextCursor !== null) && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={goToPreviousPage}
            disabled={currentPage === 1 || isLoading}
          >
            ← Previous
          </Button>
          {/* Number buttons: only pages reached so far (maxKnownPage) --
              see this file's header comment on why a page beyond that
              can't be shown or clicked yet (its cursor, and whether it
              has any items at all, isn't known until Next/a cache-miss
              click reaches it). */}
          {Array.from({ length: maxKnownPage }, (_, i) => i + 1).map((page) => (
            <Button
              key={page}
              type="button"
              variant={page === currentPage ? "primary" : "secondary"}
              onClick={() => goToPage(page)}
              disabled={isLoading}
              aria-current={page === currentPage ? "page" : undefined}
            >
              {page}
            </Button>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={goToNextPage}
            disabled={displayState.nextCursor === null || isLoading}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
