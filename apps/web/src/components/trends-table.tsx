// Ranked cross-company hiring trends table (ROADMAP.md Milestone P.2/
// P.3, spec's "secondary context" framing -- see hiring-signals-spec.md
// line 5/23: company-level trends are secondary context, not the
// primary product). Renders GET /api/v1/trends/hiring's
// HiringTrendCompany[] rows: company identity, new/active counts, an
// acceleration indicator, top location, latest signal, and a link into
// that company's own timeline page (/companies/[slug], Milestone O.2).
//
// Remains the complete, sortable, linkable record of every trending
// company the query returned -- trends-chart.tsx (spec §2.3, promoted
// 2026-08-19) sits above this and renders only the top few rows of the
// same already-fetched data as a compact visual summary; this table is
// still where the full list and the per-company link live, not
// replaced or duplicated by the chart.
import Link from "next/link";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";
import { SIGNAL_TYPE_LABELS } from "@/lib/labels";
import { DataLabel } from "./ui/data-label";

interface TrendsTableProps {
  trends: HiringTrendCompany[];
}

const EM_DASH = "\u2014";

function formatSignalAt(iso: string | null): string {
  if (!iso) return EM_DASH;
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function topLocationLabel(topLocations: HiringTrendCompany["topLocations"]): string {
  if (topLocations.length === 0) return EM_DASH;
  return topLocations[0].countryCode ?? EM_DASH;
}

// acceleration is a 0-1 normalized value (computeAcceleration, shared
// with signal-score.ts) -- shown with 4 decimal places for precision
// instead of text labels, since the actual differences matter for ranking.
function accelerationLabel(acceleration: number): string {
  return acceleration.toFixed(4);
}

export function TrendsTable({ trends }: TrendsTableProps) {
  if (trends.length === 0) {
    return (
      <div className="border-2 border-ink p-6 flex flex-col items-center gap-2 text-center">
        <p className="font-display text-sm font-bold uppercase">No trending companies found.</p>
        <p className="font-display text-sm text-soft-ink">Try a different role or widening the window.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border-2 border-ink">
      <table className="w-full text-left border-collapse min-w-[720px]">
        <caption className="sr-only">
          Companies ranked by hiring trend, most active first.
        </caption>
        <thead>
          <tr className="border-b-2 border-ink">
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Company
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              New
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Active
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Trend
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Velocity
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Top location
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              Latest signal
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              &nbsp;
            </th>
          </tr>
        </thead>
        <tbody>
          {trends.map((trend) => (
            <tr key={trend.company.slug} className="border-b border-ink last:border-b-0 align-top">
              <td className="py-2 px-4">
                <span className="font-display text-sm font-bold">{trend.company.displayName}</span>
                {trend.company.industry && (
                  <DataLabel className="block text-soft-ink">{trend.company.industry}</DataLabel>
                )}
              </td>
              <td className="py-2 px-4 font-display text-sm font-bold">{trend.newJobsCount}</td>
              <td className="py-2 px-4 font-display text-sm">{trend.activeJobsCount}</td>
              <td className="py-2 px-4">
                <DataLabel>{accelerationLabel(trend.acceleration)}</DataLabel>
              </td>
              <td className="py-2 px-4 font-display text-sm">
                {trend.hiringVelocityScore ?? EM_DASH}
              </td>
              <td className="py-2 px-4 font-display text-sm text-soft-ink">
                {topLocationLabel(trend.topLocations)}
              </td>
              <td className="py-2 px-4 font-display text-sm text-soft-ink">
                {trend.latestSignalType
                  ? (SIGNAL_TYPE_LABELS as Record<string, string>)[trend.latestSignalType] ??
                    trend.latestSignalType
                  : EM_DASH}
                <DataLabel className="block">{formatSignalAt(trend.latestSignalAt)}</DataLabel>
              </td>
              <td className="py-2 px-4">
                <Link
                  href={`/companies/${trend.company.slug}`}
                  className="font-display text-xs font-bold uppercase tracking-wide underline whitespace-nowrap"
                >
                  View company &rarr;
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
