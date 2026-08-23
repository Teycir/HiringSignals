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
import { InfoTooltip } from "./ui/info-tooltip";
import { TIE_BREAK_WEIGHT } from "./trends-chart";

interface TrendsTableProps {
  trends: HiringTrendCompany[];
  sort: "acceleration_desc" | "velocity_desc" | "volume_desc";
}

const EM_DASH = "\u2014";

function formatSignalAt(iso: string | null): string {
  if (!iso) return EM_DASH;
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}



// acceleration is a 0-1 normalized value (computeAcceleration, shared
// with signal-score.ts) -- shown as a whole-number percentage (e.g.
// "100%", "47%") rather than the raw decimal. A fixed 4-decimal-place
// number (1.0000) reads as noise, not signal, especially once a company
// clears the acceleration threshold and saturates to exactly 1 -- see
// trends-chart.tsx's own header comment on this same saturation being a
// real, common outcome on this still-young dataset, not a formatting
// bug. Percent keeps the "higher = accelerating faster" meaning
// legible at a glance without four digits of precision nobody reads a
// ranked list to get.
function accelerationLabel(acceleration: number): string {
  return `${Math.round(acceleration * 100)}%`;
}

// Apply same tie-breaker sorting as chart for consistency
function sortTrends(trends: HiringTrendCompany[], sort: TrendsTableProps["sort"]): HiringTrendCompany[] {
  const sorted = [...trends];
  const maxJobs = Math.max(...trends.map((t) => t.newJobsCount), 0);

  if (sort === "acceleration_desc") {
    sorted.sort((a, b) => {
      const aValue = a.acceleration + (maxJobs > 0 ? a.newJobsCount / maxJobs * TIE_BREAK_WEIGHT : 0);
      const bValue = b.acceleration + (maxJobs > 0 ? b.newJobsCount / maxJobs * TIE_BREAK_WEIGHT : 0);
      return bValue - aValue;
    });
  } else if (sort === "velocity_desc") {
    sorted.sort((a, b) => {
      if (a.hiringVelocityScore === null && b.hiringVelocityScore === null) return 0;
      if (a.hiringVelocityScore === null) return 1;
      if (b.hiringVelocityScore === null) return -1;
      return b.hiringVelocityScore - a.hiringVelocityScore;
    });
  } else {
    sorted.sort((a, b) => b.newJobsCount - a.newJobsCount);
  }
  return sorted;
}

export function TrendsTable({ trends, sort }: TrendsTableProps) {
  const sortedTrends = sortTrends(trends, sort);
  
  if (sortedTrends.length === 0) {
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
              <span className="inline-flex items-center">
                New (7d)
                <InfoTooltip label="Jobs first spotted in the last 7 days. Some may have closed since." />
              </span>
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              <span className="inline-flex items-center">
                Open now
                <InfoTooltip label="Jobs still live right now, of any age — not just this week's." />
              </span>
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              <span className="inline-flex items-center">
                Trend
                <InfoTooltip label="Hiring pace vs. the prior period. Higher means accelerating." />
              </span>
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              <span className="inline-flex items-center">
                Velocity
                <InfoTooltip label="Overall hiring speed score. Recomputed daily; dash means not yet scored." />
              </span>
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              <span className="inline-flex items-center">
                Latest signal
                <InfoTooltip label="The most recent hiring event we detected for this company." />
              </span>
            </th>
            <th scope="col" className="py-2 px-4 font-display text-xs font-bold uppercase tracking-wide">
              &nbsp;
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedTrends.map((trend) => (
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
