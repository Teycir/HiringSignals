"use client";
// Trend block (spec 10.5: "Trend block: active matching roles over 7,
// 30, and 90 days"). ROADMAP V.4: now fetches real role-scoped new/active
// job counts from GET /api/v1/companies/:slug/role-activity for the three
// windows and renders them inline, rather than linking out to the full
// company timeline as a workaround. The company timeline link is kept as
// secondary context below the inline table.
//
// Fetches on mount using the same resolvedForKey pattern as other detail
// components (signal-detail-page, company-page) -- no useSearchParams,
// so no Suspense boundary needed here; this is a pure prop-driven client
// component mounted by signal-detail.tsx.
import { useEffect, useState } from "react";
import Link from "next/link";
import type { RoleCategory } from "@hiring-signals/domain";
import { fetchCompanyRoleActivity, isAbortError, type CompanyRoleActivityBucket } from "@/lib/api-client";
import { DataLabel } from "./ui/data-label";

interface TrendBlockProps {
  companyDisplayName: string;
  companySlug: string;
  /** The signal's roleCategory -- passed through from SignalDetail so
   * this component can scope the activity query to the matching role. */
  roleCategory: RoleCategory;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; buckets: CompanyRoleActivityBucket[] };

export function TrendBlock({ companyDisplayName, companySlug, roleCategory }: TrendBlockProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchCompanyRoleActivity(companySlug, roleCategory, { signal: controller.signal })
      .then((res) => {
        setState({ status: "ready", buckets: res.data.buckets });
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        console.error("[TrendBlock] Failed to load role activity:", err);
        setState({ status: "error" });
      });
    return () => controller.abort();
  }, [companySlug, roleCategory]);

  return (
    <section aria-labelledby="trend-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
      <h2 id="trend-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Trend
      </h2>

      {state.status === "loading" && (
        <div className="h-12 bg-muted animate-pulse" aria-busy="true" aria-label="Loading trend data" />
      )}

      {state.status === "error" && (
        <p className="font-display text-sm text-soft-ink">
          Trend data unavailable right now.
        </p>
      )}

      {state.status === "ready" && (
        <table className="w-full text-left border-collapse">
          <caption className="sr-only">
            New and active jobs for this role at {companyDisplayName} over three windows.
          </caption>
          <thead>
            <tr className="border-b border-ink">
              <th scope="col" className="pb-1 pr-6 font-display text-xs font-bold uppercase tracking-wide">Window</th>
              <th scope="col" className="pb-1 pr-6 font-display text-xs font-bold uppercase tracking-wide">New</th>
              <th scope="col" className="pb-1 font-display text-xs font-bold uppercase tracking-wide">Active</th>
            </tr>
          </thead>
          <tbody>
            {state.buckets.map((b) => (
              <tr key={b.window} className="border-b border-ink last:border-b-0">
                <td className="py-1 pr-6"><DataLabel>{b.window}</DataLabel></td>
                <td className="py-1 pr-6 font-display text-sm font-bold">{b.newJobsCount}</td>
                <td className="py-1 font-display text-sm">{b.activeJobsCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Link
        href={`/companies/${companySlug}`}
        className="font-display text-xs text-soft-ink underline self-start"
      >
        View full company timeline &rarr;
      </Link>
    </section>
  );
}
