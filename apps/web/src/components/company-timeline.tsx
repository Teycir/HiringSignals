// Company hiring timeline (ROADMAP.md Milestone O.1/O.2, spec §1.4/
// §10.1). Renders GET /api/v1/companies/:slug/timeline's bucketed
// new/closed/active job counts as a table -- most-recent bucket first,
// each row showing the bucket's date range, counts, and a capped
// top-N role/location breakdown (see CompanyHiringTimelineBucket's own
// header comment in packages/db/src/types.ts: roleBreakdown/
// locationBreakdown are capped lists, not exhaustive, so this renders
// them as-is rather than assuming completeness).
import type { CompanyHiringTimelineBucket } from "@hiring-signals/db/src/types";
import { ROLE_LABELS } from "@/lib/labels";
import { DataLabel } from "./ui/data-label";

interface CompanyTimelineProps {
  buckets: CompanyHiringTimelineBucket[];
}

const EM_DASH = "\u2014";

function formatBucketRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return `${fmt.format(start)} \u2013 ${fmt.format(end)}`;
}

function roleLabel(roleCategory: string | null): string {
  if (!roleCategory) return EM_DASH;
  return (ROLE_LABELS as Record<string, string>)[roleCategory] ?? roleCategory;
}

function formatBreakdown<T extends { count: number }>(
  items: Array<T>,
  labelFor: (item: T) => string,
): string {
  if (items.length === 0) return EM_DASH;
  return items.map((item) => `${labelFor(item)} (${item.count})`).join(", ");
}

export function CompanyTimeline({ buckets }: CompanyTimelineProps) {
  if (buckets.length === 0) {
    return (
      <section aria-labelledby="timeline-heading" className="border-2 border-ink p-4">
        <h2 id="timeline-heading" className="font-display text-sm font-bold uppercase tracking-wide mb-2">
          Hiring timeline
        </h2>
        <p className="font-display text-sm text-soft-ink">No hiring activity recorded for this window.</p>
      </section>
    );
  }

  // Most recent bucket first -- the API returns buckets in bucketStart
  // ascending order (chronological, matching how they're computed), so
  // this view reverses for display since a reader scanning a company
  // page wants "what's happening now" at the top, not the oldest window.
  const orderedBuckets = [...buckets].reverse();

  return (
    <section aria-labelledby="timeline-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
      <h2 id="timeline-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Hiring timeline
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[640px]">
          <caption className="sr-only">
            Bucketed new, closed, and active job counts over time, most recent first.
          </caption>
          <thead>
            <tr className="border-b-2 border-ink">
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Window
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                New
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Closed
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Active
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Roles
              </th>
              <th scope="col" className="py-2 font-display text-xs font-bold uppercase tracking-wide">
                Locations
              </th>
            </tr>
          </thead>
          <tbody>
            {orderedBuckets.map((bucket) => (
              <tr key={bucket.bucketStart} className="border-b border-ink last:border-b-0 align-top">
                <td className="py-2 pr-4">
                  <DataLabel>{formatBucketRange(bucket.bucketStart, bucket.bucketEnd)}</DataLabel>
                </td>
                <td className="py-2 pr-4 font-display text-sm font-bold">{bucket.newJobsCount}</td>
                <td className="py-2 pr-4 font-display text-sm">{bucket.closedJobsCount}</td>
                <td className="py-2 pr-4 font-display text-sm">{bucket.activeJobsCount}</td>
                <td className="py-2 pr-4 font-display text-sm text-soft-ink">
                  {formatBreakdown(bucket.roleBreakdown, (r) => roleLabel(r.roleCategory))}
                </td>
                <td className="py-2 font-display text-sm text-soft-ink">
                  {formatBreakdown(bucket.locationBreakdown, (l) => l.countryCode ?? EM_DASH)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
