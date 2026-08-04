// Trend block (spec 10.5: "Trend block: active matching roles over 7,
// 30, and 90 days").
//
// BLOCKED, confirmed against source before writing this: SignalDetail
// (packages/db/src/types.ts) carries no historical role-count series,
// and no repo function computes "active matching roles" bucketed by
// 7/30/90-day windows for a given signal's (company, role) pair --
// getCompanyRoleActivityStats (packages/db, feeds the score's V/A/B
// components) computes point-in-time counts for scoring, not a 3-point
// trend series, and isn't exposed via the API either way. ROADMAP.md's
// F.5 entry flags this exact gap ("may need a follow-up repo function
// or can defer to Milestone O's timeline work").
//
// Rather than invent numbers, this renders an honest "not yet
// available" state so the section exists in the right place in the
// layout (spec's required section ordering) without misrepresenting
// data that was never computed. Replace the body once a real trend
// endpoint/field exists -- the props boundary is deliberately minimal
// (just roleCategory/companyDisplayName for the copy) so that swap only
// touches this file.
interface TrendBlockProps {
  companyDisplayName: string;
}

export function TrendBlock({ companyDisplayName }: TrendBlockProps) {
  return (
    <section aria-labelledby="trend-heading" className="border-2 border-ink p-4 flex flex-col gap-2">
      <h2 id="trend-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Trend
      </h2>
      <p className="font-display text-sm text-soft-ink">
        Historical trend data for {companyDisplayName}&apos;s active matching roles over 7, 30,
        and 90 days isn&apos;t available yet. This will show once trend tracking ships.
      </p>
    </section>
  );
}
