"use client";
// Signal feed (spec 12.2 steps 3 & 5 -- fetch + cancel stale requests;
// URL parsing/sync, steps 1/2/4, is the /signals page's job, not this
// component's -- same division as company-combobox.tsx not touching
// the URL either). Cursor-based pagination, page-scoped (not
// accumulate-forever "load more"): FilterState.cursor is deliberately
// never round-tripped through the URL (see searchParams.ts's
// serializeFilterState comment -- a new filter combination invalidates
// pagination), so the current page's items plus a small history of
// past-page cursors (for Previous) live in this component's own state,
// reset whenever `filters` changes. DEFAULT_LIMIT (searchParams.ts) is
// 15 -- one page's worth, not a fetch batch size -- so a page never
// shows more than 15 signals at once, unlike the earlier
// accumulate-into-one-long-list "Load more" behavior.
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

  // Page-history cursor stack: pastCursors[i] is the cursor that
  // fetched the page *before* the current one (undefined for page 1,
  // the initial fetch with no cursor at all). goToNextPage pushes the
  // current page's own request cursor before advancing; goToPreviousPage
  // pops it and re-fetches with it. Reset to [] whenever filters change
  // (new filter combination invalidates any prior page position, same
  // as cursor itself never round-tripping through the URL -- see this
  // file's header comment). Reset happens inline during render (the
  // "adjusting state when a prop changes" pattern React's own docs
  // recommend -- react.dev/learn/you-might-not-need-an-effect#adjusting-
  // some-state-when-a-prop-changes), comparing filterKey against the
  // last-seen value stored in state (see lastFilterKey below), NOT in a
  // useEffect: this codebase's own set-state-in-effect lint rule (see
  // the FeedState comment above) flags exactly that shape (a bare
  // setState at the top of an effect body), and this reset is a direct
  // analogue of resetting a component whenever a `key`-like prop
  // changes.
  const [pastCursors, setPastCursors] = useState<(string | undefined)[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);
  const pageNumber = pastCursors.length + 1;

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
  // reset pagination state back to page 1, synchronously during render
  // (see the comment on pastCursors above for why this isn't a
  // useEffect). lastFilterKey is plain useState, not useRef: this
  // codebase's lint config (React Compiler-era rules) forbids reading or
  // writing a ref's `.current` during render entirely (refs are for
  // effects/handlers only) -- storing the "previous value to compare
  // against" in state instead is the compiler-safe version of the same
  // "adjusting state when a prop changes" pattern. Initialized to
  // filterKey itself (useState's lazy-init form runs once) so the very
  // first render is never treated as "filters changed."
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    if (pastCursors.length > 0 || currentCursor !== undefined) {
      setPastCursors([]);
      setCurrentCursor(undefined);
    }
  }

  // fetchKey folds currentCursor in too, so a page navigation (same
  // filters, different cursor) is recognized as "not yet resolved" the
  // same way a filter change is -- both go through the one effect below.
  // Deliberately built from filterKey + currentCursor as they stand
  // *after* the render-time reset above, so a filter change and its
  // pagination reset are always reflected together, never one render
  // behind the other.
  const fetchKey = `${filterKey}::${currentCursor ?? ""}`;
  const isLoading = resolvedForKey !== fetchKey;

  useEffect(() => {
    if (resolvedForKey === fetchKey) return;

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
  }, [fetchKey, resolvedForKey, filters, currentCursor]);

  // When the feed resolves empty with no active filters, check source
  // staleness once (sourceStatus === null guard prevents re-fetching).
  useEffect(() => {
    if (
      isLoading ||
      state.status !== "ready" ||
      state.items.length !== 0 ||
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
  }, [isLoading, state, filters, sourceStatus]);

  function goToNextPage() {
    if (state.status !== "ready" || state.nextCursor === null || isLoading) return;
    setPastCursors((prev) => [...prev, currentCursor]);
    setCurrentCursor(state.nextCursor);
  }

  function goToPreviousPage() {
    if (pastCursors.length === 0 || isLoading) return;
    const prevCursor = pastCursors[pastCursors.length - 1];
    setPastCursors((prev) => prev.slice(0, -1));
    setCurrentCursor(prevCursor);
  }

  function retry() {
    // Resetting resolvedForKey to something that can't equal the current
    // fetchKey lets the effect's own guard/fetch logic re-run naturally
    // on next render, rather than duplicating the fetch here a third time.
    setResolvedForKey(null);
  }

  if (isLoading) {
    // First-load skeleton (spec 10.6: "preserve dense layout", not a
    // generic spinner) -- fixed count of card-shaped placeholders at
    // the same border/padding as SignalCard so the layout doesn't jump
    // once real results arrive. Capped at DEFAULT_LIMIT (15) rather than
    // a fixed 6, matching the real page size so the skeleton's height
    // doesn't visibly shrink once results replace it. Kept small (not
    // literally 15 placeholder blocks) since the skeleton only needs to
    // suggest "a page of cards is coming," not pixel-match the final count.
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

  if (state.status === "error") {
    // Spec 10.6: "compact error panel with retry, no raw stack trace."
    // ApiClientError.message is server-authored user-facing text (see
    // api-client.ts's apiErrorSchema); a plain Error (network failure,
    // JSON parse failure) gets a generic message instead of its raw
    // message/stack.
    const message =
      state.error instanceof ApiClientError ? state.error.message : "Couldn't load signals.";
    return (
      <div className="border-2 border-ink p-4 flex flex-col gap-3">
        <p className="font-display text-sm font-bold">{message}</p>
        <Button type="button" variant="secondary" onClick={retry} className="self-start">
          Retry
        </Button>
      </div>
    );
  }

  if (state.items.length === 0) {
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

  return (
    <div className="flex flex-col gap-3">
      {state.items.map((signal) => (
        <SignalCard key={signal.id} signal={signal} />
      ))}
      {(pastCursors.length > 0 || state.nextCursor !== null) && (
        <div className="flex items-center justify-center gap-4 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={goToPreviousPage}
            disabled={pastCursors.length === 0 || isLoading}
          >
            ← Previous
          </Button>
          <span className="font-display text-xs text-soft-ink uppercase">
            Page {pageNumber}
          </span>
          <Button
            type="button"
            variant="secondary"
            onClick={goToNextPage}
            disabled={state.nextCursor === null || isLoading}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
