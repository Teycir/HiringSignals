// Trend block (spec 10.5: "Trend block: active matching roles over 7,
// 30, and 90 days").
//
// PARTIALLY RESOLVED by Milestone O.1 (added 2026-08-08, after this
// component was first written): GET /api/v1/companies/:slug/timeline
// now returns real time-bucketed new/closed/active job counts. That
// data is company-wide across all roles, not scoped to this specific
// signal's (company, role) pair the way spec 10.5's literal wording
// asks for -- getCompanyRoleActivityStats (the per-role point-in-time
// query that feeds the score's V/A/B components) still isn't exposed as
// a bucketed series via the API. Rather than fetch and mislabel the
// company-wide timeline as if it were role-scoped, this links out to
// the real timeline view (/companies/[slug], Milestone O.2) with an
// honest caption about the scope difference, instead of inlining
// possibly-misleading numbers here.
import Link from "next/link";

interface TrendBlockProps {
  companyDisplayName: string;
  companySlug: string;
}

export function TrendBlock({ companyDisplayName, companySlug }: TrendBlockProps) {
  return (
    <section aria-labelledby="trend-heading" className="border-2 border-ink p-4 flex flex-col gap-2">
      <h2 id="trend-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Trend
      </h2>
      <p className="font-display text-sm text-soft-ink">
        A role-specific 7/30/90-day trend for this signal isn&apos;t available yet, but
        {" "}{companyDisplayName}&apos;s full hiring timeline (all roles) is.
      </p>
      <Link
        href={`/companies/${companySlug}`}
        className="font-display text-sm font-bold uppercase tracking-wide underline self-start"
      >
        View company timeline &rarr;
      </Link>
    </section>
  );
}
