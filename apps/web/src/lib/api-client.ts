import { z } from "zod";
import type {
  CompanyHiringTimelineBucket,
  CompanyRecentSignal,
  CompanySummary,
  Facets,
  HiringTrendCompany,
  SignalDetail,
  SignalListItem,
} from "@hiring-signals/db/src/types";
import type { AtsProvider, RoleCategory, SignalType } from "@hiring-signals/domain";

/**
 * Single place the browser talks to the Worker API (spec 12.1). Never call
 * ATS providers directly from a client component -- everything goes through
 * this file, which only ever hits NEXT_PUBLIC_API_BASE_URL (public by
 * design, spec 4.4 -- it's a URL, not a secret).
 *
 * Types are imported from "@hiring-signals/db/src/types", NOT the package
 * root ("@hiring-signals/db"). The root barrel also re-exports
 * signals-repo.ts/companies-repo.ts/etc., which import D1Client from
 * d1-client.ts (ambient D1Database type, from @cloudflare/workers-types --
 * a devDependency of packages/db, not apps/web). tsc resolves a module's
 * full type graph even for `import type`-only usage (unlike bundler
 * tree-shaking), so importing the root barrel fails apps/web's typecheck
 * with "Cannot find name 'D1Database'". types.ts has zero D1 imports by
 * design (see its header comment), so importing it directly avoids the
 * problem entirely -- this file must never import a *value* from
 * @hiring-signals/db (e.g. createD1Client) either way, since apps/web is a
 * client bundle with no D1 binding.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export class ApiClientError extends Error {
  code: string;
  requestId: string;

  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * A cancelled `fetch` (AbortController.abort()) rejects with a DOMException
 * named "AbortError" -- not an ApiClientError. Callers that race a request
 * against filter-state changes (spec 12.2 step 5, signal-feed.tsx) need to
 * tell "the user changed filters again" apart from "the request failed",
 * so they don't show a real error state for an intentional cancellation.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const body = await res.json();

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiClientError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.requestId,
      );
    }
    throw new ApiClientError("UNKNOWN_ERROR", "Request failed.", "req_unknown");
  }

  return body as T;
}

/**
 * Mirrors apps/api/src/routes/signals.ts's signalsQuerySchema exactly --
 * same field names, same optionality -- so URL/filter state built against
 * this type never drifts from what the live route actually accepts.
 */
export interface SignalListParams {
  roles?: RoleCategory[];
  company?: string;
  q?: string;
  locationMode?: "remote" | "hybrid" | "onsite" | "unknown";
  country?: string;
  source?: AtsProvider;
  signalType?: SignalType;
  minScore?: number;
  observedSince?: string;
  sort?: "score_desc" | "newest" | "company_asc";
  cursor?: string;
  limit?: number;
}

export interface SignalListResponse {
  data: SignalListItem[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    nextCursor: string | null;
    searchMode: "keyword" | "hybrid";
  };
}

/** GET /api/v1/signals (spec 9.2, 9.3, 12.2). */
export async function fetchSignals(
  params: SignalListParams = {},
  init?: RequestInit,
): Promise<SignalListResponse> {
  const query = new URLSearchParams();
  if (params.roles?.length) query.set("roles", params.roles.join(","));
  if (params.company) query.set("company", params.company);
  if (params.q) query.set("q", params.q);
  if (params.locationMode) query.set("locationMode", params.locationMode);
  if (params.country) query.set("country", params.country);
  if (params.source) query.set("source", params.source);
  if (params.signalType) query.set("signalType", params.signalType);
  if (params.minScore !== undefined) query.set("minScore", String(params.minScore));
  if (params.observedSince) query.set("observedSince", params.observedSince);
  if (params.sort) query.set("sort", params.sort);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));

  return request<SignalListResponse>(`/api/v1/signals?${query.toString()}`, init);
}

/** GET /api/v1/signals/:signalId (spec 9.2, 10.5). */
export async function fetchSignalDetail(
  signalId: string,
  init?: RequestInit,
): Promise<{ data: SignalDetail; meta: { requestId: string } }> {
  return request(`/api/v1/signals/${encodeURIComponent(signalId)}`, init);
}

/** GET /api/v1/facets (spec 9.2, 10.4). */
export async function fetchFacets(
  init?: RequestInit,
): Promise<{ data: Facets; meta: { requestId: string; cached: boolean } }> {
  return request("/api/v1/facets", init);
}

/** GET /api/v1/companies?q= (spec 9.2, 10.4's company-combobox typeahead). */
export async function fetchCompanies(
  params: { q?: string; limit?: number } = {},
  init?: RequestInit,
): Promise<{ data: CompanySummary[]; meta: { requestId: string } }> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.limit !== undefined) query.set("limit", String(params.limit));

  return request(`/api/v1/companies?${query.toString()}`, init);
}

/**
 * GET /api/v1/companies/:slug (spec 9.2, 10.5 trend block; Milestone Q.3).
 * Returns the company row plus its recent active signals and, since
 * Milestone Q, a precomputed hiringVelocityScore (nullable until the
 * daily reconciliation pass has run at least once for this company) and
 * the shared HIRING_VELOCITY_DISCLAIMER string in `meta`.
 */
export async function fetchCompanyDetail(
  slug: string,
  init?: RequestInit,
): Promise<{
  data: CompanySummary & { recentSignals: CompanyRecentSignal[] };
  meta: { requestId: string; hiringVelocityDisclaimer: string };
}> {
  return request(`/api/v1/companies/${encodeURIComponent(slug)}`, init);
}

/**
 * GET /api/v1/companies/:slug/timeline (ROADMAP.md Milestone O.1, spec
 * §1.4/§10.1). Time-bucketed hiring activity for one company. `since`/
 * `until` default server-side (90d-ago/now) when omitted; `bucketDays`
 * must be one of 7/14/30 (server defaults to 14). Mirrors
 * companyTimelineQuerySchema's param names exactly.
 */
export interface CompanyTimelineParams {
  roles?: RoleCategory;
  since?: string;
  until?: string;
  bucketDays?: 7 | 14 | 30;
}

export async function fetchCompanyTimeline(
  slug: string,
  params: CompanyTimelineParams = {},
  init?: RequestInit,
): Promise<{
  data: { company: CompanySummary; buckets: CompanyHiringTimelineBucket[] };
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}> {
  const query = new URLSearchParams();
  if (params.roles) query.set("roles", params.roles);
  if (params.since) query.set("since", params.since);
  if (params.until) query.set("until", params.until);
  if (params.bucketDays !== undefined) query.set("bucketDays", String(params.bucketDays));

  return request(`/api/v1/companies/${encodeURIComponent(slug)}/timeline?${query.toString()}`, init);
}

/**
 * GET /api/v1/trends/hiring (ROADMAP.md Milestone P.2, spec §1.2/§2.3).
 * Cross-company hiring trend ranking -- "which companies started hiring
 * X in the last N days," not one company's own timeline (that's O.1
 * above). `roles` is required server-side (>=1 role, comma-delimited);
 * `since` defaults server-side (30d-ago) when omitted. Response rows
 * carry each company's hiringVelocityScore (Milestone Q.3) alongside
 * the trend metrics.
 */
export interface TrendsParams {
  roles: RoleCategory[];
  industry?: string;
  country?: string;
  since?: string;
  sort?: "acceleration_desc" | "volume_desc" | "newest_signal" | "velocity_desc";
  limit?: number;
}

/**
 * GET /api/v1/companies/:slug/role-activity (ROADMAP V.4, spec §10.5
 * TrendBlock). Returns new/active job counts for one (company, role)
 * pair bucketed at 7, 30, and 90 days.
 */
export interface CompanyRoleActivityBucket {
  window: "7d" | "30d" | "90d";
  newJobsCount: number;
  activeJobsCount: number;
}

export async function fetchCompanyRoleActivity(
  slug: string,
  role: RoleCategory,
  init?: RequestInit,
): Promise<{
  data: {
    company: { slug: string; displayName: string };
    role: RoleCategory;
    buckets: CompanyRoleActivityBucket[];
  };
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}> {
  const query = new URLSearchParams({ role });
  return request(
    `/api/v1/companies/${encodeURIComponent(slug)}/role-activity?${query.toString()}`,
    init,
  );
}

/**
 * Minimal source shape for the UI's staleness check. Field names are
 * camelCase to match packages/db/src/sources-repo.ts's `SourceSummary`
 * (the DTO shape `toSummary()` actually serializes over the wire) --
 * NOT the raw D1 `SourceRow` (snake_case), which never reaches the
 * client. This only declares the fields signal-feed.tsx/masthead.tsx
 * actually read so apps/web's bundle doesn't pull in the full DB type
 * graph. (Previously snake_case here silently diverged from the real
 * API response, causing `.filter(Boolean)` to drop every entry and the
 * "last sync" label to be permanently stuck on "pending" -- 2026-08-17.)
 */
export interface SourceSummary {
  id: string;
  lastSuccessAt: string | null;
}

/** GET /api/v1/sources (spec 9.2). Used by signal-feed.tsx to detect
 * "never synced" / "stale" states for the empty-feed message. */
export async function fetchSources(
  init?: RequestInit,
): Promise<{ data: SourceSummary[]; meta: { requestId: string } }> {
  return request("/api/v1/sources", init);
}

export async function fetchTrends(
  params: TrendsParams,
  init?: RequestInit,
): Promise<{
  data: HiringTrendCompany[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    cached: boolean;
    hiringVelocityDisclaimer: string;
  };
}> {
  const query = new URLSearchParams();
  query.set("roles", params.roles.join(","));
  if (params.industry) query.set("industry", params.industry);
  if (params.country) query.set("country", params.country);
  if (params.since) query.set("since", params.since);
  if (params.sort) query.set("sort", params.sort);
  if (params.limit !== undefined) query.set("limit", String(params.limit));

  return request(`/api/v1/trends/hiring?${query.toString()}`, init);
}

