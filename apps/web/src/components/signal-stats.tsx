"use client";
// Descriptive statistics for the current filtered signal set: score
// distribution (min/mean/median/max/p25/p75/count) plus per-type and
// per-role breakdown counts. Sits above SignalFeed the same way
// TrendsChart sits above TrendsTable (trends-chart.tsx) -- a compact
// summary of the exact same filtered rows the feed below it shows, not
// a disconnected global number: it calls fetchSignalStats with the same
// FilterState -> SignalListParams mapping (toApiParams, searchParams.ts)
// signal-feed.tsx already uses for fetchSignals, so "stats for what I'm
// looking at" can never silently drift from what the feed actually
// contains.
//
// Plain numbers/lists, not a chart: min/mean/median/max/p25/p75 are six
// scalar values best read at a glance, and the two breakdown lists
// (bySignalType/byRoleCategory) are typically 2-6 entries each -- well
// under the row count where TrendsChart's own header comment says a
// chart stops being a faster read than a plain list. If either
// breakdown ever regularly exceeds ~8 entries, revisit as a bar chart
// the way TrendsChart already handles a longer ranked list.
//
// Fetched independently of SignalFeed, not derived from its already-
// fetched page: SignalFeed only ever holds one page (DEFAULT_LIMIT
// rows, searchParams.ts) of up to `limit` items, so client-side stats
// over that page would silently describe "the 15 rows currently
// displayed" rather than the full filtered set -- exactly the kind of
// misleading number a stats card must not show. getSignalStats
// (signals-repo.ts) computes over the full filtered set server-side
// (score distribution capped defensively at STATS_ROW_CAP, with
// `truncated` reported honestly when exceeded; count/breakdowns are
// always exact).
import { useEffect, useState } from "react";
import type { SignalStats as SignalStatsData } from "@hiring-signals/db/src/types";
import { fetchSignalStats, isAbortError } from "@/lib/api-client";
import { toApiParams, type FilterState } from "@/lib/searchParams";
import { ROLE_LABELS, SIGNAL_TYPE_LABELS } from "@/lib/labels";

interface SignalStatsProps {
  filters: FilterState;
}

type StatsState =
  | { status: "ready"; data: SignalStatsData }
  | { status: "error" };

/** Formats a score stat for display -- one decimal place is enough
 * precision for a 0-100 integer-scored distribution (matches
 * trends-chart.tsx's own convention of formatting to the metric's
 * natural precision, not an arbitrary fixed one). Null (empty
 * distribution, see SignalScoreStats' own doc comment) renders as an
 * em dash, not "0" or "NaN" -- 0 would misrepresent an empty set as a
 * real score of zero. */
function fmt(v: number | null): string {
  return v === null ? "\u2014" : v.toFixed(1);
}

/** One breakdown row's share of the total, as a whole-percent string.
 * total === 0 can't actually reach this (breakdown lists are empty
 * when count is 0 -- see the empty-state branch below), but the guard
 * keeps this safe to call independent of that invariant. */
function pct(count: number, total: number): string {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
}

export function SignalStats({ filters }: SignalStatsProps) {
  // No "loading" member in StatsState itself: isLoading is derived below
  // by comparing resolvedForKey against the current paramsKey -- same
  // pattern signal-feed.tsx's own FeedState uses (see that file's header
  // comment), needed here for the same reason: this codebase's
  // react-hooks/set-state-in-effect lint rule flags a synchronous
  // setState at the top of an effect body (e.g. setting a "loading"
  // status right before the fetch call), so "is a request in flight"
  // has to be a plain derived expression instead of its own state value.
  const [state, setState] = useState<StatsState | null>(null);
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);

  // JSON.stringify of the resolved API params (not the FilterState
  // object reference) as the effect dependency -- same reasoning as
  // signal-feed.tsx's filterKey: a new FilterState object with equal
  // contents is created every render by the parent, and would
  // otherwise re-trigger this effect on every render rather than only
  // on an actual filter change.
  const paramsKey = JSON.stringify(toApiParams(filters));
  const isLoading = resolvedForKey !== paramsKey;

  useEffect(() => {
    if (resolvedForKey === paramsKey) return;

    const controller = new AbortController();
    fetchSignalStats(toApiParams(filters), { signal: controller.signal })
      .then((res) => {
        setState({ status: "ready", data: res.data });
        setResolvedForKey(paramsKey);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        console.error("[SignalStats] Failed to fetch stats:", err);
        setState({ status: "error" });
        setResolvedForKey(paramsKey);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the intentional dependency, see comment above; filters/resolvedForKey are read but re-running on their identity churn (a fresh FilterState object every render) would defeat the fetchKey-style guard this effect relies on.
  }, [paramsKey]);

  // Fails quiet, not loud: a stats summary is supplementary context
  // above the feed, not a blocking requirement -- if it can't load,
  // the feed itself (signal-feed.tsx, fetched independently) still
  // works. No retry button, unlike SignalFeed's error state, since
  // there's nothing actionable for the user to do about a summary
  // widget failing (the identical request will just run again next
  // time filters change).
  if (state?.status === "error") return null;

  if (isLoading || state === null) {
    return (
      <section
        aria-label="Signal statistics"
        aria-busy="true"
        className="border-2 border-ink p-4 h-24 bg-muted animate-pulse"
      />
    );
  }

  const { score, bySignalType, byRoleCategory, truncated } = state.data;

  if (score.count === 0) {
    // Same "nothing to summarize" case SignalFeed's own empty state
    // handles for the feed itself -- this card just says so briefly
    // rather than duplicating SignalFeed's fuller no-data/stale/no-
    // match messaging (that context already lives one section below).
    return (
      <section aria-label="Signal statistics" className="border-2 border-ink p-4">
        <p className="data-label text-soft-ink">No signals match the current filters.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="signal-stats-heading" className="border-2 border-ink p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="signal-stats-heading" className="font-display text-sm font-bold uppercase tracking-wide">
          Score distribution &middot; {score.count} signal{score.count === 1 ? "" : "s"}
        </h2>
        {truncated && (
          <span className="data-label text-soft-ink">
            Distribution approximated over the first {score.count.toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {(
          [
            ["Min", score.min],
            ["P25", score.p25],
            ["Median", score.median],
            ["Mean", score.mean],
            ["P75", score.p75],
            ["Max", score.max],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="data-label text-soft-ink uppercase">{label}</span>
            <span className="font-display text-lg font-bold" style={{ fontFamily: "var(--font-mono)" }}>
              {fmt(value)}
            </span>
          </div>
        ))}
      </div>

      {(bySignalType.length > 0 || byRoleCategory.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-muted">
          {bySignalType.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="data-label text-soft-ink uppercase">By signal type</h3>
              {bySignalType.map((row) => (
                <div key={row.signalType} className="flex items-baseline justify-between gap-2 text-sm">
                  <span>{SIGNAL_TYPE_LABELS[row.signalType]}</span>
                  <span className="data-label text-soft-ink whitespace-nowrap">
                    {row.count} ({pct(row.count, score.count)})
                  </span>
                </div>
              ))}
            </div>
          )}
          {byRoleCategory.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="data-label text-soft-ink uppercase">By role</h3>
              {byRoleCategory.map((row) => (
                <div key={row.roleCategory} className="flex items-baseline justify-between gap-2 text-sm">
                  <span>{ROLE_LABELS[row.roleCategory]}</span>
                  <span className="data-label text-soft-ink whitespace-nowrap">
                    {row.count} ({pct(row.count, score.count)})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
