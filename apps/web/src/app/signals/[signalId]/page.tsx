"use client";
// /signals/[signalId] (spec 10.5): "A direct route plus optional side
// panel on wide screens" -- this ships the required direct route; the
// side-panel enhancement is explicitly optional per spec and deferred.
//
// Client-fetch, not a server component reading fetchSignalDetail
// directly: mirrors signals-view.tsx's established pattern (useEffect +
// api-client.ts call) rather than introducing a second fetch strategy
// into the codebase. No useSearchParams() here (route param, not a
// query string), so unlike signals-view.tsx this needs no Suspense
// boundary -- params comes in as a plain prop.
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { SignalDetail as SignalDetailType } from "@hiring-signals/db/src/types";
import { AppShell } from "@/components/app-shell";
import { SignalDetail } from "@/components/signal-detail";
import { Button } from "@/components/ui/button";
import { fetchSignalDetail, ApiClientError, isAbortError } from "@/lib/api-client";

type DetailState =
  | { status: "error"; error: ApiClientError | Error }
  | { status: "not_found" }
  | { status: "ready"; signal: SignalDetailType };

export default function SignalDetailPage() {
  const params = useParams<{ signalId: string }>();
  const signalId = params.signalId;
  // No "loading" member in DetailState itself, and no synchronous
  // setState at the top of the effect body -- same pattern as
  // signal-feed.tsx/company-combobox.tsx (react-hooks/set-state-in-effect
  // flags that as a cascading-render risk). isLoading is derived by
  // comparing resolvedForKey against the current fetchKey instead.
  const [state, setState] = useState<DetailState>({ status: "not_found" });
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);
  // retryCount is folded into fetchKey (not a separate effect
  // dependency) so "retry" is just "invalidate resolvedForKey for this
  // key" -- one mechanism for both the initial fetch and a retry,
  // mirroring signal-feed.tsx's retry() which resets resolvedForKey to
  // null rather than duplicating the fetch call.
  const [retryCount, setRetryCount] = useState(0);
  const fetchKey = `${signalId}:${retryCount}`;
  const isLoading = resolvedForKey !== fetchKey;

  useEffect(() => {
    if (resolvedForKey === fetchKey) return;

    const controller = new AbortController();

    fetchSignalDetail(signalId, { signal: controller.signal })
      .then((res) => {
        setState({ status: "ready", signal: res.data });
        setResolvedForKey(fetchKey);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        if (err instanceof ApiClientError && err.code === "NOT_FOUND") {
          setState({ status: "not_found" });
        } else {
          setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
        }
        setResolvedForKey(fetchKey);
      });

    return () => controller.abort();
  }, [fetchKey, resolvedForKey, signalId]);

  if (isLoading) {
    return (
      <AppShell>
        <div className="p-4 md:p-6 max-w-3xl flex flex-col gap-3" aria-busy="true" aria-label="Loading signal">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border-2 border-ink p-4 h-20 bg-muted animate-pulse" />
          ))}
        </div>
      </AppShell>
    );
  }

  if (state.status === "not_found") {
    return (
      <AppShell>
        <div className="p-4 md:p-6 max-w-3xl border-2 border-ink p-6 flex flex-col items-center gap-3 text-center">
          <p className="font-display text-sm font-bold uppercase">Signal not found.</p>
          <p className="font-display text-sm text-soft-ink">
            It may have expired, or the link may be incorrect.
          </p>
        </div>
      </AppShell>
    );
  }

  if (state.status === "error") {
    const message =
      state.error instanceof ApiClientError ? state.error.message : "Couldn't load this signal.";
    return (
      <AppShell>
        <div className="p-4 md:p-6 max-w-3xl border-2 border-ink p-4 flex flex-col gap-3">
          <p className="font-display text-sm font-bold">{message}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setRetryCount((c) => c + 1)}
            className="self-start"
          >
            Retry
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <SignalDetail signal={state.signal} />
    </AppShell>
  );
}
