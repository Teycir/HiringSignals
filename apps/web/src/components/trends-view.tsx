"use client";
// The actual /trends content (ROADMAP.md Milestone P.2/P.3). Mirrors
// signals-view.tsx's URL-as-source-of-truth pattern: role selection and
// filters live in the URL, not separately-tracked client state, so a
// shared link reproduces the same view. Lives in components/, not
// app/trends/page.tsx, for the same useSearchParams()-needs-Suspense
// reason signals-view.tsx's own header comment documents -- see
// app/trends/page.tsx's thin wrapper.
//
// Unlike /signals, there's no FilterRail here: GET /api/v1/trends/hiring
// requires >=1 role (comma-delimited, see api-client.ts's TrendsParams)
// rather than making role optional, so the role selector is a
// multi-select chip-toggle at the top of the page content itself,
// following signal-type-filter.tsx's Button-toggle styling rather than
// role-filter.tsx's Checkbox list -- P.3's original ranked-table-only
// framing (spec: company trends are secondary context, not a dashboard)
// is why the filter UI stays a compact toggle row rather than a full
// filter rail; that reasoning is about the filter controls, not the
// results view below, which now also renders TrendsChart (spec §2.3,
// promoted 2026-08-19) above TrendsTable for the same already-fetched
// data -- see trends-chart.tsx's own header comment.
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ROLE_CATEGORIES, type RoleCategory } from "@hiring-signals/domain";
import type { HiringTrendCompany } from "@hiring-signals/db/src/types";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { TrendsTable } from "@/components/trends-table";
import { TrendsChart } from "@/components/trends-chart";
import { ROLE_LABELS } from "@/lib/labels";
import { fetchTrends, ApiClientError, isAbortError, type TrendsParams } from "@/lib/api-client";

type SortOption = NonNullable<TrendsParams["sort"]>;

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "acceleration_desc", label: "Accelerating" },
  { value: "velocity_desc", label: "Velocity" },
  { value: "volume_desc", label: "Volume" },
];

// Maps the active table sort to the chart's value axis (spec §2.3
// promotion, see trends-chart.tsx's own header comment) so the bars
// above TrendsTable always represent whatever metric the table below
// is actually ranked by.
function sortToChartMetric(sort: SortOption): "acceleration" | "velocity" | "volume" {
  if (sort === "velocity_desc") return "velocity";
  if (sort === "volume_desc") return "volume";
  return "acceleration";
}

function isRoleCategory(value: string): value is RoleCategory {
  return (ROLE_CATEGORIES as readonly string[]).includes(value);
}

const DEFAULT_ROLE: RoleCategory = ROLE_CATEGORIES[0];

// Defaults to software_engineering only when the URL never had a
// `roles` key at all (a fresh /trends landing) so results populate
// immediately instead of showing "select at least one role" on first
// load. Distinguished from the user explicitly clearing every chip --
// that case leaves `roles=` (empty string, not absent) via
// updateParams below, so `raw === null` (missing key) is the only
// branch that applies the default; `raw === ""` (present-but-empty)
// correctly falls through to the real empty-selection state.
function parseRoles(searchParams: URLSearchParams): RoleCategory[] {
  const raw = searchParams.get("roles");
  if (raw === null) return [DEFAULT_ROLE];
  if (raw === "") return [];
  return raw.split(",").filter(isRoleCategory);
}

function parseSort(searchParams: URLSearchParams): SortOption {
  const raw = searchParams.get("sort");
  return SORT_OPTIONS.some((o) => o.value === raw) ? (raw as SortOption) : "acceleration_desc";
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: ApiClientError | Error }
  // snapshotCapturedAt (snapshot-persistence-plan.md, replaces the
  // 2026-09-02 stale/staleAsOf pair): every response is now a D1
  // snapshot read, so there's no "fresh vs stale" distinction to flag
  // as an anomaly -- this is just "when was this data last captured,"
  // shown as a routine footnote rather than a warning banner.
  | { status: "ready"; data: HiringTrendCompany[]; disclaimer: string; snapshotCapturedAt: string | null };

export function TrendsView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedRoles = parseRoles(searchParams);
  const sort = parseSort(searchParams);
  const industry = searchParams.get("industry") ?? "";
  const country = searchParams.get("country") ?? "";

  const [state, setState] = useState<LoadState>({ status: "idle" });

  function updateParams(next: { roles?: RoleCategory[]; sort?: SortOption; industry?: string; country?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    const roles = next.roles ?? selectedRoles;
    // Empty (not deleted): distinguishes "user cleared every role chip"
    // from "roles was never in the URL" so parseRoles's default only
    // fires on a genuinely fresh landing, not after a deliberate clear.
    params.set("roles", roles.join(","));
    const nextSort = next.sort ?? sort;
    if (nextSort !== "acceleration_desc") params.set("sort", nextSort); else params.delete("sort");
    const nextIndustry = next.industry ?? industry;
    if (nextIndustry) params.set("industry", nextIndustry); else params.delete("industry");
    const nextCountry = next.country ?? country;
    if (nextCountry) params.set("country", nextCountry); else params.delete("country");
    router.replace(`/trends?${params.toString()}`, { scroll: false });
  }

  function toggleRole(role: RoleCategory) {
    const next = selectedRoles.includes(role)
      ? selectedRoles.filter((r) => r !== role)
      : [...selectedRoles, role];
    updateParams({ roles: next });
  }

  // Request-key pattern (same as app/companies/[slug]/page.tsx's
  // resolvedForKey): `state`/`resolvedForKey` only ever get written
  // from a promise callback (a real effect/external-system boundary),
  // never synchronously at the top of the effect body -- avoids the
  // react-hooks/set-state-in-effect cascading-render warning that a
  // bare `setState({ status: "loading" })` before the fetch triggers.
  // "Loading" is instead derived below (`effectiveState`) by comparing
  // fetchKey against resolvedForKey, the same way isLoading is derived
  // on the company page.
  const fetchKey = `${selectedRoles.join(",")}:${sort}:${industry}:${country}`;
  const [resolvedForKey, setResolvedForKey] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRoles.length === 0 || resolvedForKey === fetchKey) return;

    const controller = new AbortController();

    fetchTrends(
      { roles: selectedRoles, sort, industry: industry || undefined, country: country || undefined },
      { signal: controller.signal },
    )
      .then((res) => {
        setState({
          status: "ready",
          data: res.data,
          disclaimer: res.meta.hiringVelocityDisclaimer,
          snapshotCapturedAt: res.meta.snapshotCapturedAt,
        });
        setResolvedForKey(fetchKey);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
        setResolvedForKey(fetchKey);
      });

    return () => controller.abort();
  }, [fetchKey, resolvedForKey, selectedRoles, sort, industry, country]);

  // Derived, not stored: whenever selectedRoles is empty the view is
  // idle regardless of whatever `state` a prior (now-superseded) fetch
  // left behind; otherwise "loading" is exactly "the key we want isn't
  // the key we've resolved yet" -- avoids a stale "ready"/"error" state
  // flashing after the user deselects their last role or changes a
  // filter.
  const effectiveState: LoadState =
    selectedRoles.length === 0
      ? { status: "idle" }
      : resolvedForKey !== fetchKey
        ? { status: "loading" }
        : state;

  return (
    <AppShell>
      <div className="p-4 md:p-6 flex flex-col gap-4">
        <header className="flex flex-col gap-1 border-b-2 border-ink pb-4">
          <h1 className="font-display text-xl font-bold">Hiring trends</h1>
          <p className="font-display text-sm text-soft-ink">
            Companies ranked by hiring pace across the roles you select. Secondary context, not a
            prediction of budget or intent.
          </p>
        </header>

        <fieldset className="flex flex-col gap-2">
          <legend className="font-display text-sm font-bold uppercase">Roles</legend>
          <div aria-label="Roles" className="flex flex-wrap gap-2">
            {ROLE_CATEGORIES.map((role) => (
              <Button
                key={role}
                type="button"
                variant={selectedRoles.includes(role) ? "primary" : "secondary"}
                aria-pressed={selectedRoles.includes(role)}
                onClick={() => toggleRole(role)}
                className="px-3 py-2 text-xs"
              >
                {ROLE_LABELS[role]}
              </Button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold uppercase tracking-wide">Industry</span>
            <input
              type="text"
              value={industry}
              onChange={(e) => updateParams({ industry: e.target.value })}
              placeholder="Any"
              className="border-2 border-ink px-3 py-2 font-display text-sm bg-paper"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold uppercase tracking-wide">Country</span>
            <input
              type="text"
              value={country}
              onChange={(e) => updateParams({ country: e.target.value })}
              placeholder="Any"
              className="border-2 border-ink px-3 py-2 font-display text-sm bg-paper"
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="font-display text-xs font-bold uppercase tracking-wide">Sort</legend>
            <div className="flex flex-wrap gap-2">
              {SORT_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant={sort === opt.value ? "primary" : "secondary"}
                  aria-pressed={sort === opt.value}
                  onClick={() => updateParams({ sort: opt.value })}
                  className="px-3 py-2 text-xs"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>

        {effectiveState.status === "idle" && (
          <div className="border-2 border-ink p-6 flex flex-col items-center gap-2 text-center">
            <p className="font-display text-sm font-bold uppercase">Select at least one role.</p>
            <p className="font-display text-sm text-soft-ink">
              Trends require at least one role category to rank companies by.
            </p>
          </div>
        )}

        {effectiveState.status === "loading" && (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading trends">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border-2 border-ink p-4 h-16 bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {effectiveState.status === "error" && (
          <div className="border-2 border-ink p-4 flex flex-col gap-3">
            <p className="font-display text-sm font-bold">
              {effectiveState.error instanceof ApiClientError
                ? effectiveState.error.message
                : "Couldn't load trends."}
            </p>
            {/* Resets resolvedForKey (not fetchKey/params, which haven't
                changed) so the effect's guard sees a fresh key and
                refetches -- updateParams({}) alone would be a no-op
                here since nothing in the URL actually changed. */}
            <Button
              type="button"
              variant="secondary"
              onClick={() => setResolvedForKey(null)}
              className="self-start"
            >
              Retry
            </Button>
          </div>
        )}

        {effectiveState.status === "ready" && (
          <>
            <TrendsChart trends={effectiveState.data} metric={sortToChartMetric(sort)} />
            <TrendsTable trends={effectiveState.data} sort={sort} />
            <p className="font-display text-xs text-soft-ink">
              {effectiveState.disclaimer}
              {effectiveState.snapshotCapturedAt
                ? ` Data as of ${new Date(effectiveState.snapshotCapturedAt).toLocaleString()}.`
                : ""}
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
