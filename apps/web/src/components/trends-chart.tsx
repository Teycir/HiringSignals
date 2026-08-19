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
}

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
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  metricLabel: string;
  format: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="border-2 border-ink bg-paper px-3 py-2">
      <p className="font-display text-sm font-bold">{row.name}</p>
      <p className="data-label text-soft-ink">
        {metricLabel}: {format(row.value)}
      </p>
    </div>
  );
}

export function TrendsChart({ trends, metric }: TrendsChartProps) {
  if (trends.length === 0) return null;

  const config = METRIC_CONFIG[metric];
  const rows: ChartRow[] = trends.slice(0, CHART_LIMIT).map((t) => ({
    slug: t.company.slug,
    name: truncateName(t.company.displayName),
    value: config.getValue(t),
  }));

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
              content={<ChartTooltip metricLabel={config.label} format={config.format} />}
            />
            <Bar dataKey="value" isAnimationActive={false}>
              {rows.map((row, index) => (
                <Cell key={row.slug} fill={index === 0 ? "var(--accent)" : "var(--ink)"} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                formatter={(value: React.ReactNode) =>
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
