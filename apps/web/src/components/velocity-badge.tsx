// Hiring velocity score display (ROADMAP.md Milestone Q.3, spec §11.3/
// §14.3). Mirrors score-breakdown.tsx's badge + plain-language-weights
// pattern, but for the company-level velocity score
// (packages/domain/src/hiring-velocity.ts's computeHiringVelocity)
// rather than a per-signal score. Unlike score-breakdown.tsx, the real
// formula weights ARE known here (VELOCITY formula is a fixed, documented
// constant -- see hiring-velocity.ts) so this renders the real weights,
// not a generic description.
//
// hiringVelocityScore is null until the daily reconciliation pass
// (Q.2's handleVelocityRecompute) has run at least once for a company --
// renders an honest "not yet computed" state rather than a fake 0,
// since 0 would misrepresent "no hiring activity" vs. "not measured yet".
//
// disclaimer is passed in from the caller's API response meta
// (hiringVelocityDisclaimer), not hardcoded here, so this component can
// never drift from HIRING_VELOCITY_DISCLAIMER's actual current wording.
import { DataLabel } from "./ui/data-label";

interface VelocityBadgeProps {
  score: number | null;
  computedAt: string | null;
  disclaimer: string;
}

const VELOCITY_FACTORS: Array<{ label: string; weight: string; description: string }> = [
  {
    label: "Acceleration",
    weight: "40%",
    description: "Whether new postings across all roles are speeding up compared to the recent past.",
  },
  {
    label: "Breadth",
    weight: "25%",
    description: "How many distinct locations are currently hiring, across every role category.",
  },
  {
    label: "Volume",
    weight: "20%",
    description: "Total count of active roles open right now, across every role category.",
  },
  {
    label: "Persistence",
    weight: "15%",
    description: "How long this company has had continuous hiring signal history.",
  },
];

function formatComputedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function VelocityBadge({ score, computedAt, disclaimer }: VelocityBadgeProps) {
  const isHighVelocity = score !== null && score >= 80;

  return (
    <section aria-labelledby="velocity-heading" className="border-2 border-ink p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="velocity-heading" className="font-display text-sm font-bold uppercase tracking-wide">
          Hiring velocity
        </h2>
        {score === null ? (
          <DataLabel className="px-3 py-1.5 font-bold text-soft-ink">Not yet computed</DataLabel>
        ) : score === 0 ? (
          <DataLabel className="px-3 py-1.5 font-bold text-soft-ink">N/A</DataLabel>
        ) : (
          <DataLabel
            className={`px-3 py-1.5 font-bold text-base ${
              isHighVelocity ? "bg-accent text-ink" : "bg-ink text-paper"
            }`}
          >
            {score}
          </DataLabel>
        )}
      </div>

      {score === null ? (
        <p className="font-display text-sm text-soft-ink">
          This company&apos;s velocity score hasn&apos;t been computed yet. It&apos;s calculated by a
          daily reconciliation pass and will appear here once it has run at least once for this
          company.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {VELOCITY_FACTORS.map((factor) => (
              <li key={factor.label} className="flex items-start gap-3">
                <DataLabel className="shrink-0 w-12 text-right font-bold">{factor.weight}</DataLabel>
                <div className="flex flex-col">
                  <span className="font-display text-sm font-bold">{factor.label}</span>
                  <span className="font-display text-sm text-soft-ink">{factor.description}</span>
                </div>
              </li>
            ))}
          </ul>
          {computedAt && (
            <DataLabel className="text-soft-ink">Computed {formatComputedAt(computedAt)}</DataLabel>
          )}
        </>
      )}

      <p className="font-display text-xs text-soft-ink border-t border-ink pt-3">{disclaimer}</p>
    </section>
  );
}
