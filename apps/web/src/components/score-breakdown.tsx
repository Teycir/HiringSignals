// Plain-language score breakdown (spec 10.5: "Score and plain-language
// breakdown"). ROADMAP V.3: now renders the real per-signal R/V/A/B/Q
// component values when they are present (signals written after
// migration 0010), and falls back to the generic formula description
// for older rows where all five components are null.
//
// ScoreComponents are persisted at write time by createSignal/
// refreshSignal/updateSignalScore (packages/db/src/signals-write-repo.ts)
// and returned via GET /api/v1/signals/:id's SignalDetail.scoreComponents
// field (packages/db/src/types.ts). Q is stored as `confidence` (the
// raw classification_confidence value, matching ScoreComponents["quality"]
// naming in domain -- "quality" is the formula label, "confidence" is
// the DB column / API field name).
import type { SignalDetail } from "@hiring-signals/db/src/types";
import { DataLabel } from "./ui/data-label";

interface ScoreBreakdownProps {
  signal: Pick<SignalDetail, "score" | "scoreVersion" | "scoreComponents">;
}

interface FactorRow {
  label: string;
  weight: string;
  description: string;
  /** 0-1 component value, present for new rows; null for pre-migration rows. */
  value: number | null;
}

function buildFactorRows(
  components: SignalDetail["scoreComponents"],
): FactorRow[] {
  return [
    {
      label: "Freshness",
      weight: "35%",
      description: "How recently this signal's evidence was observed. Decays the longer it's been.",
      value: components?.freshness ?? null,
    },
    {
      label: "Volume",
      weight: "25%",
      description: "How many active roles are currently open for this company and role category.",
      value: components?.volume ?? null,
    },
    {
      label: "Acceleration",
      weight: "20%",
      description: "Whether new postings in this role category are speeding up compared to the recent past.",
      value: components?.acceleration ?? null,
    },
    {
      label: "Breadth",
      weight: "10%",
      description: "How many distinct locations are hiring for this role category right now.",
      value: components?.breadth ?? null,
    },
    {
      label: "Quality",
      weight: "10%",
      description: "Confidence in the automated role classification for the underlying job posting.",
      value: components?.confidence ?? null,
    },
  ];
}

/** Formats a 0-1 component value as a percentage string (e.g. 0.73 → "73%"). */
function formatComponent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function ScoreBreakdown({ signal }: ScoreBreakdownProps) {
  const isHighScore = signal.score >= 80;
  const factors = buildFactorRows(signal.scoreComponents);
  const hasRealComponents = signal.scoreComponents !== null;

  return (
    <section aria-labelledby="score-breakdown-heading" className="border-2 border-ink p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="score-breakdown-heading" className="font-display text-sm font-bold uppercase tracking-wide">
          Score
        </h2>
        <DataLabel
          className={`px-3 py-1.5 font-bold text-base ${
            isHighScore ? "bg-accent text-ink" : "bg-ink text-paper"
          }`}
        >
          {signal.score}
        </DataLabel>
      </div>

      {hasRealComponents ? (
        <p className="font-display text-sm">
          Score = 35%&thinsp;R + 25%&thinsp;V + 20%&thinsp;A + 10%&thinsp;B + 10%&thinsp;Q
          (spec §7.2). Component values at the time this signal was last computed:
        </p>
      ) : (
        <p className="font-display text-sm">
          This score weighs five factors from publicly observable job-posting activity. Individual
          factor values for this specific signal aren&apos;t exposed by the API yet — the weights
          below describe how the formula works in general.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {factors.map((factor) => (
          <li key={factor.label} className="flex items-start gap-3">
            <DataLabel className="shrink-0 w-12 text-right font-bold">{factor.weight}</DataLabel>
            <div className="flex flex-col flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-display text-sm font-bold">{factor.label}</span>
                {factor.value !== null && (
                  <DataLabel className="font-bold">{formatComponent(factor.value)}</DataLabel>
                )}
              </div>
              <span className="font-display text-sm text-soft-ink">{factor.description}</span>
            </div>
          </li>
        ))}
      </ul>

      <DataLabel className="text-soft-ink">Formula version: {signal.scoreVersion}</DataLabel>
    </section>
  );
}
