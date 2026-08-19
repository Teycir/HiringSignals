"use client";
// Cross-company hiring trend chart (spec §2.3 "trend charts", promoted
// from P2/deferred to built 2026-08-19 -- see hiring-signals-spec.md's
// own §2.3 header comment and CHANGELOG.md for the promotion decision).
// Renders the exact same GET /api/v1/trends/hiring HiringTrendCompany[]
// rows trends-view.tsx already fetches for TrendsTable -- no new
// endpoint, no second request. Sits above TrendsTable as a compact
// visual summary of the same ranked list; the table remains the
// complete, sortable, linkable record (trends-table.tsx's own header
// comment called this "a plain ranked table, not a chart-heavy
// dashboard" -- that framing predates this promotion and is
// deliberately superseded here, not silently contradicted).
//
// Horizontal bars, not vertical: company display names are long and
// variable-length (see trends-table.tsx's first column) and don't
// truncate gracefully on a category axis the way they do on a value
// axis label -- horizontal bars keep names fully readable without
// rotation or ellipsis at any reasonable chart width, including mobile.
//
// Capped to CHART_LIMIT (top 8 of whatever `trends` already contains,
// which is itself already sorted by the caller's chosen `sort` --
// resolveTrendsSince/buildTrendsCacheKey's own route already ranks
// server-side, this component never re-sorts). Beyond ~8-10 horizontal
// bars a chart stops being a faster read than the table it sits above;
// the full list stays one scroll away in TrendsTable regardless of this
// cap.
//
// Colors: strict ink/muted/soft-ink per globals.css's "no themeable UI,
// one scarce accent color" rule (spec 11.1/19.2) -- recharts renders raw
// SVG, which doesn't inherit Tailwind utility classes, so every stroke/
// fill below is a literal var(--...) CSS custom-property reference, not
// a class name. --accent is reserved for the #1-ranked bar only (same
// "scarce, CTA-adjacent" usage velocity-badge.tsx's isHighVelocity badge
// already establishes), not applied to every bar -- an all-accent chart
// would both violate the token's own "scarce" intent and defeat the
// point of highlighting a leader.
//
// Tie-break bar length (added 2026-08-19, found live: every visible bar
// under acceleration_desc rendered 1.00 -- computeAcceleration
// (signal-score.ts) is clamp(..., 0, 1), so it genuinely saturates once
// a company's recent-vs-prior hiring rate clears the threshold, which
// most active companies do on this still-young dataset (same root
// dataset-age cause as the earlier NEW/ACTIVE fix, CHANGELOG [1.1.2]).
// Real ties, not a chart bug -- but a bar chart's whole job is showing
// rank, so identical-length bars defeat the point.
//
// newJobsCount is the tie-break for every metric mode, not just
// acceleration: it's the one field populated on every row regardless of
// which sort is active (hiringVelocityScore is null for most companies
// right now -- Q.2's daily reconciliation pass hasn't recomputed it for
// everyone yet, confirmed live 2026-08-19 -- so it can't double as a
// reliable tiebreak for the other two modes either). Normalized to the
// VISIBLE rows' own max newJobsCount (not some global constant) and
// scaled to TIE_BREAK_WEIGHT (15%) of the visible rows' own max primary
// value, so the nudge only ever spreads apart genuine ties -- it can
// never be large enough to make a lower-primary-value company's bar
// visually exceed a higher-primary-value one. The LABEL to the right of
// each bar always shows the true, unmodified primary metric value
// (config.format(row.value), not row.barValue) -- the tie-break only
// changes bar LENGTH, never the displayed number, so nothing is
// misrepresented. The tooltip shows both values explicitly labeled for
// the same reason.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";

interface TrendsChartProps {
  trends: HiringTrendCompany[];
  /** Which metric the active bars represent -- mirrors trends-view.tsx's
   * SortOption so the chart's value axis always matches what the table
   * below it is actually sorted by, rather than always showing
   * acceleration regardless of the user's chosen sort. */
  metric: "acceleration" | "velocity" | "volume";
}

const CHART_LIMIT = 8;
const BAR_HEIGHT_PX = 36;
const CHART_FONT = "var(--font-mono)";

interface ChartRow {
  slug: string;
  name: string;
  value: number;
  /** Bar LENGTH only -- primary value nudged by a normalized newJobsCount
   * tiebreak (see file header comment). Never shown as text; the label
   * and tooltip always read `value` via config.format, untouched. */
  barValue: number;
}

const TIE_BREAK_WEIGHT = 0.15;

const METRIC_CONFIG: Record<
  TrendsChartProps["metric"],
  { label: string; getValue: (t: HiringTrendCompany) => number; format: (v: number) => string }
> = {
  acceleration: {
    label: "Acceleration",
    getValue: (t) => t.acceleration,
    format: (v) => v.toFixed(2),
  },
  velocity: {
    label: "Velocity score",
    getValue: (t) => t.hiringVelocityScore ?? 0,
    format: (v) => String(Math.round(v)),
  },
  volume: {
    label: "New jobs",
    getValue: (t) => t.newJobsCount,
    format: (v) => String(Math.round(v)),
  },
};

// Company display names truncated for the Y-axis category label only --
// the full name is still available via the tooltip and, unabridged, in
// TrendsTable's first column right below this chart.
function truncateName(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1)}\u2026` : name;
}

function ChartTooltip({
  active,
  payload,
  metricLabel,
  format,
  tiedValues,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  metricLabel: string;
  format: (v: number) => string;
  tiedValues: Set<number>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const isTied = tiedValues.has(row.value);
  return (
    <div className="border-2 border-ink bg-paper px-3 py-2">
      <p className="font-display text-sm font-bold">{row.name}</p>
      <p className="data-label text-soft-ink">
        {metricLabel}: {format(row.value)}
      </p>
      {isTied && (
        <p className="data-label text-soft-ink">
          Bar length includes a tie-break nudge from new-job volume; the
          score above is the true value.
        </p>
      )}
    </div>
  );
}

export function TrendsChart({ trends, metric }: TrendsChartProps) {
  if (trends.length === 0) return null;

  const config = METRIC_CONFIG[metric];
  const visible = trends.slice(0, CHART_LIMIT);

  // Both maxes are over the VISIBLE rows only, not some global/dataset
  // constant -- what counts as "a tie worth spreading apart" is relative
  // to what's actually on screen.
  const maxPrimary = Math.max(...visible.map((t) => config.getValue(t)), 0);
  const maxJobs = Math.max(...visible.map((t) => t.newJobsCount), 0);

  const rows: ChartRow[] = visible.map((t) => {
    const value = config.getValue(t);
    // 0..1, or 0 if every visible row has 0 new jobs (avoid /0).
    const tieBreakFraction = maxJobs > 0 ? t.newJobsCount / maxJobs : 0;
    // Nudge is capped at TIE_BREAK_WEIGHT of the visible rows' own max
    // primary value -- large enough to visibly separate exact ties,
    // never large enough to let a lower-value row's bar overtake a
    // genuinely higher-value row (max nudge < min real gap this metric's
    // rounding/precision can produce isn't guaranteed in general, but
    // for these three metrics' actual ranges it holds in practice; this
    // is a display nudge, not a rescoring, and worth re-checking if a
    // fourth metric with a very fine-grained scale is ever added).
    const barValue = value + tieBreakFraction * TIE_BREAK_WEIGHT * maxPrimary;
    return {
      slug: t.company.slug,
      name: truncateName(t.company.displayName),
      value,
      barValue,
    };
  });

  // Genuine ties only -- a value shared by 2+ visible rows -- not "any
  // row whose bar got nudged at all" (nearly every row with newJobsCount
  // > 0 would match that looser check, making the tooltip note noisy
  // rather than informative).
  const valueCounts = new Map<number, number>();
  for (const row of rows) {
    valueCounts.set(row.value, (valueCounts.get(row.value) ?? 0) + 1);
  }
  const tiedValues = new Set(
    [...valueCounts.entries()].filter(([, count]) => count > 1).map(([v]) => v),
  );

  // Recharts needs an explicit pixel height (ResponsiveContainer only
  // controls width) -- scaled to row count so a short list (e.g. 2
  // companies matching a narrow role/industry filter) doesn't render a
  // mostly-empty tall chart with awkwardly thick bars.
  const chartHeight = Math.max(rows.length * BAR_HEIGHT_PX, BAR_HEIGHT_PX * 2) + 24;

  return (
    <section aria-labelledby="trends-chart-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="trends-chart-heading" className="font-display text-sm font-bold uppercase tracking-wide">
          Top {rows.length} by {config.label.toLowerCase()}
        </h2>
        {trends.length > CHART_LIMIT && (
          <span className="data-label text-soft-ink">
            {trends.length - CHART_LIMIT} more in the table below
          </span>
        )}
      </div>

      <div style={{ width: "100%", height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 32, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--muted)" horizontal={false} />
            <XAxis
              type="number"
              stroke="var(--ink)"
              tick={{ fill: "var(--soft-ink)", fontFamily: CHART_FONT, fontSize: 11 }}
              tickLine={{ stroke: "var(--ink)" }}
              axisLine={{ stroke: "var(--ink)" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              stroke="var(--ink)"
              tick={{ fill: "var(--ink)", fontFamily: CHART_FONT, fontSize: 12 }}
              tickLine={{ stroke: "var(--ink)" }}
              axisLine={{ stroke: "var(--ink)" }}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={
                <ChartTooltip metricLabel={config.label} format={config.format} tiedValues={tiedValues} />
              }
            />
            {/* dataKey="barValue" drives bar LENGTH (primary value + tie-break
                nudge). LabelList's dataKey="value" pulls the true, unmodified
                primary value from the same row for the text label -- recharts
                reads label text from whatever dataKey is set on LabelList,
                independent of what field the enclosing Bar uses for geometry,
                so this pairing is intentional, not a mismatch. */}
            <Bar dataKey="barValue" isAnimationActive={false}>
              {rows.map((row, index) => (
                <Cell key={row.slug} fill={index === 0 ? "var(--accent)" : "var(--ink)"} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                formatter={(value: unknown) =>
                  typeof value === "number" ? config.format(value) : String(value ?? "")
                }
                style={{ fill: "var(--ink)", fontFamily: CHART_FONT, fontSize: 11 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
