"use client";
// Extracted from app/companies/[slug]/page.tsx (SEO fix, 2026-08-17):
// same reasoning as components/signal-detail-view.tsx's header comment
// -- that file needed to become a server component so it could export
// generateMetadata (a company's real name/industry in <title>/<meta
// description>, instead of the root layout's generic fallback every
// crawler saw before this split). Fetch-on-mount rendering logic is
// unchanged from before the split; it just lives here now so page.tsx
// can stay a server component. slug comes in as a plain prop from the
// server page.tsx.
import { useEffect, useState } from "react";
import type { CompanyHiringTimelineBucket, CompanyRecentSignal, CompanySummary } from "@hiring-signals/db/src/types";
import { AppShell } from "@/components/app-shell";
import { VelocityBadge } from "@/components/velocity-badge";
import { CompanyTimeline } from "@/components/company-timeline";
import { Button } from "@/components/ui/button";
import { DataLabel } from "@/components/ui/data-label";
import { ROLE_LABELS } from "@/lib/labels";
import { fetchCompanyDetail, fetchCompanyTimeline, ApiClientError, isAbortError } from "@/lib/api-client";

interface CompanyPageData {
  company: CompanySummary;
  recentSignals: CompanyRecentSignal[];
  buckets: CompanyHiringTimelineBucket[];
  hiringVelocityDisclaimer: string;
}

type PageState =
  | { status: "error"; error: ApiClientError | Error }
  | { status: "not_found" }
  | { status: "ready"; data: CompanyPageData };

function formatSignalTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function CompanyPageView({ slug }: { slug: string }) {
  const [state, setState] = useState<PageState>({ status: "not_found" });
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const fetchKey = `${slug}:${retryCount}`;
  const isLoading = resolvedForKey !== fetchKey;

  useEffect(() => {
    if (resolvedForKey === fetchKey) return;

    const controller = new AbortController();

    Promise.all([
      fetchCompanyDetail(slug, { signal: controller.signal }),
      fetchCompanyTimeline(slug, {}, { signal: controller.signal }),
    ])
      .then(([detailRes, timelineRes]) => {
        setState({
          status: "ready",
          data: {
            company: detailRes.data,
            recentSignals: detailRes.data.recentSignals,
            buckets: timelineRes.data.buckets,
            hiringVelocityDisclaimer: detailRes.meta.hiringVelocityDisclaimer,
          },
        });
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
  }, [fetchKey, resolvedForKey, slug]);

  if (isLoading) {
    return (
      <AppShell>
        <div className="p-4 md:p-6 max-w-3xl flex flex-col gap-3" aria-busy="true" aria-label="Loading company">
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
          <p className="font-display text-sm font-bold uppercase">Company not found.</p>
          <p className="font-display text-sm text-soft-ink">The slug may be incorrect.</p>
        </div>
      </AppShell>
    );
  }

  if (state.status === "error") {
    const message =
      state.error instanceof ApiClientError ? state.error.message : "Couldn't load this company.";
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

  const { company, recentSignals, buckets, hiringVelocityDisclaimer } = state.data;

  return (
    <AppShell>
      <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl">
        <header className="flex flex-col gap-1 border-b-2 border-ink pb-4">
          <h1 className="font-display text-xl font-bold">{company.displayName}</h1>
          <DataLabel className="text-soft-ink">
            {[company.domain, company.industry, company.employeeBand].filter(Boolean).join(" \u00B7 ") || "\u2014"}
          </DataLabel>
        </header>

        <VelocityBadge
          score={company.hiringVelocityScore}
          computedAt={company.velocityComputedAt}
          disclaimer={hiringVelocityDisclaimer}
        />

        <CompanyTimeline buckets={buckets} />

        <section aria-labelledby="recent-signals-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
          <h2 id="recent-signals-heading" className="font-display text-sm font-bold uppercase tracking-wide">
            Recent signals
          </h2>
          {recentSignals.length === 0 ? (
            <p className="font-display text-sm text-soft-ink">No active signals for this company right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recentSignals.map((signal) => (
                <li key={signal.id} className="flex items-start justify-between gap-3 border-b border-ink pb-2 last:border-b-0">
                  <div className="flex flex-col">
                    <span className="font-display text-sm font-bold">{signal.headline}</span>
                    <DataLabel className="text-soft-ink">
                      {(ROLE_LABELS as Record<string, string>)[signal.roleCategory] ?? signal.roleCategory}
                      {" \u00B7 "}
                      {formatSignalTime(signal.lastDetectedAt)}
                    </DataLabel>
                  </div>
                  <DataLabel className="shrink-0 font-bold">{signal.score}</DataLabel>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
