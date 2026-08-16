// Plain-language score breakdown (spec 10.5: "Score and plain-language
// breakdown"). IMPORTANT CONSTRAINT, confirmed against source before
// writing this: SignalDetail (packages/db/src/types.ts) only carries the
// final `score` + `scoreVersion` -- the R/V/A/B/Q ScoreComponents from
// computeNewJobScore (packages/domain/src/signal-score.ts) are computed
// at write time (signals-write-repo.ts) but never persisted onto the
// signal row or exposed by GET /api/v1/signals/:signalId. There is no
// per-signal component breakdown to render.
//
// Rather than fabricate plausible-looking R/V/A/B/Q numbers (which
// would misrepresent real signal evidence -- spec 7.2 explicitly
// requires scores to be recomputable/traceable from persisted
// observations), this renders a plain-language explanation of what the
// formula weighs, generically, plus the real score/version that do
// exist. If a future milestone persists components onto signal rows
// (or adds them to SignalDetail), swap the generic explanation list for
// real per-signal values -- the component boundary here is intentional
// so that swap only touches this file.
import type { SignalDetail } from "@hiring-signals/db/src/types";
import { DataLabel } from "./ui/data-label";

interface ScoreBreakdownProps {
  signal: Pick<SignalDetail, "score" | "scoreVersion">;
}

const FORMULA_FACTORS: Array<{ label: string; weight: string; description: string }> = [
  {
    label: "Freshness",
    weight: "35%",
    description: "How recently this signal's evidence was observed. Decays the longer it's been.",
  },
  {
    label: "Volume",
    weight: "25%",
    description: "How many active roles are currently open for this company and role category.",
  },
  {
    label: "Acceleration",
    weight: "20%",
    description: "Whether new postings in this role category are speeding up compared to the recent past.",
  },
  {
    label: "Breadth",
    weight: "10%",
    description: "How many distinct locations are hiring for this role category right now.",
  },
  {
    label: "Quality",
    weight: "10%",
    description: "Confidence in the automated role classification for the underlying job posting.",
  },
];

export function ScoreBreakdown({ signal }: ScoreBreakdownProps) {
  const isHighScore = signal.score >= 80;

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

      <p className="font-display text-sm">
        This score weighs five factors from publicly observable job-posting activity. Individual
        factor values for this specific signal aren&apos;t exposed by the API yet — the weights
        below describe how the formula works in general.
      </p>

      <ul className="flex flex-col gap-2">
        {FORMULA_FACTORS.map((factor) => (
          <li key={factor.label} className="flex items-start gap-3">
            <DataLabel className="shrink-0 w-12 text-right font-bold">{factor.weight}</DataLabel>
            <div className="flex flex-col">
              <span className="font-display text-sm font-bold">{factor.label}</span>
              <span className="font-display text-sm text-soft-ink">{factor.description}</span>
            </div>
          </li>
        ))}
      </ul>

      <DataLabel className="text-soft-ink">Formula version: {signal.scoreVersion}</DataLabel>
    </section>
  );
}
