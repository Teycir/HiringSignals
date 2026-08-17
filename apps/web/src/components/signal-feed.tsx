"use client";
// Signal feed (spec 12.2 steps 3 & 5 -- fetch + cancel stale requests;
// URL parsing/sync, steps 1/2/4, is the /signals page's job, not this
// component's -- same division as company-combobox.tsx not touching
// the URL either). Cursor-based "load more": FilterState.cursor is
// deliberately never round-tripped through the URL (see
// searchParams.ts's serializeFilterState comment -- a new filter
// combination invalidates pagination), so accumulated results/cursor
// live in this component's own state, reset whenever `filters` changes.
//
// Loading/empty/error states here are functional, not final: spec
// 10.6's exact copy is used for the states this component can support
// today (first load, no-filters-match, API error+retry). "No data yet"
// and "source stale" need server-side context (source_runs timing)
// that ROADMAP's F.6 notes as still unconfirmed/unbuilt -- those two
// rows, plus the polished empty-state.tsx/status-line.tsx components
// themselves, are still open F.6 work, not covered by this file.
import { useEffect, useRef, useState } from "react";
import type { SignalListItem } from "@hiring-signals/db/src/types";
import { fetchSignals, isAbortError, ApiClientError } from "@/lib/api-client";
import { toApiParams, type FilterState } from "@/lib/searchParams";
import { SignalCard } from "./signal-card";
import { Button } from "./ui/button";

interface SignalFeedProps {
  filters: FilterState;
  onResetFilters: () => void;
}

type FeedState =
  | { status: "error"; error: ApiClientError | Error }
  | { status: "ready"; items: SignalListItem[]; nextCursor: string | null; loadingMore: boolean };

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
    loadingMore: false,
  });
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Base filters (no cursor) as a stable dependency key -- JSON.stringify
  // rather than the FilterState object reference, since a new object
  // with equal contents is created every render by the /signals page
  // (parseFilterState() runs fresh each time) and would otherwise
  // re-trigger this effect on every render, not just on an actual
  // filter change.
  const filterKey = JSON.stringify(toApiParams(filters));
  const isLoading = resolvedForKey !== filterKey;

  useEffect(() => {
    if (resolvedForKey === filterKey) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetchSignals(toApiParams(filters), { signal: controller.signal })
      .then((res) => {
        setState({
          status: "ready",
          items: res.data,
          nextCursor: res.meta.nextCursor,
          loadingMore: false,
        });
        setResolvedForKey(filterKey);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
        setResolvedForKey(filterKey);
      });

    return () => controller.abort();
  }, [filterKey, resolvedForKey, filters]);

  function loadMore() {
    if (state.status !== "ready" || state.nextCursor === null || state.loadingMore) return;
    const cursor = state.nextCursor;
    setState({ ...state, loadingMore: true });

    fetchSignals({ ...toApiParams(filters), cursor })
      .then((res) => {
        setState((prev) =>
          prev.status === "ready"
            ? {
                status: "ready",
                items: [...prev.items, ...res.data],
                nextCursor: res.meta.nextCursor,
                loadingMore: false,
              }
            : prev,
        );
      })
      .catch((e) => {
        console.error("[SignalFeed] Load more failed:", e);
        setState((prev) => (prev.status === "ready" ? { ...prev, loadingMore: false } : prev));
      });
  }

  function retry() {
    // Resetting resolvedForKey to something that can't equal the current
    // filterKey lets the effect's own guard/fetch logic re-run naturally
    // on next render, rather than duplicating the fetch here a third time.
    setResolvedForKey(null);
  }

  if (isLoading) {
    // First-load skeleton (spec 10.6: "preserve dense layout", not a
    // generic spinner) -- fixed count of card-shaped placeholders at
    // the same border/padding as SignalCard so the layout doesn't jump
    // once real results arrive.
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
      {state.nextCursor !== null && (
        <Button
          type="button"
          variant="secondary"
          onClick={loadMore}
          disabled={state.loadingMore}
          className="self-center"
        >
          {state.loadingMore ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}
