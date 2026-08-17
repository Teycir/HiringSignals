import type {
  CompanyHiringTimelineBucket,
  CompanyRecentSignal,
  CompanySummary,
  Facets,
  HiringTrendCompany,
  SignalDetail,
  SignalListItem,
} from "@hiring-signals/db/src/types";
import {
  apiRequest,
  queryFromRecord,
  ApiClientError,
  type ApiFetchFn,
  type CompanyTimelineQuery,
  type SignalsQuery,
  type TrendsQuery,
} from "@hiring-signals/domain";

/**
 * Single place the browser talks to the Worker API (spec 12.1). Never call
 * ATS providers directly from a client component -- everything goes through
 * this file, which only ever hits NEXT_PUBLIC_API_BASE_URL (public by
 * design, spec 4.4 -- it's a URL, not a secret).
 *
 * The request/error-envelope/query-string plumbing lives in
 * @hiring-signals/domain's api-client-core.ts (shared with apps/cli's
 * api-client.ts, ROADMAP.md refactor 2026-08-17) -- this file only adds
 * what's genuinely apps/web-specific: the server-side service-binding
 * fetch path (serverFetch), isAbortError, and the per-route fetchers'
 * response-shape typings. Query param types (SignalsQuery, TrendsQuery,
 * CompanyTimelineQuery) are imported from @hiring-signals/domain rather
 * than hand-declared here, so they can never drift from what
 * apps/cli validates against or what the live route actually accepts --
 * this file used to hand-roll its own SignalListParams/TrendsParams/
 * CompanyTimelineParams that were never checked against the route's
 * real zod schemas.
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

export { ApiClientError };

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
  // Server-side callers (generateMetadata in companies/[slug] and
  // signals/[signalId]) route through the API service binding, not a
  // public fetch(`${API_BASE_URL}${path}`) (W.4, 2026-08-17): Cloudflare
  // returns error 1042 for any Worker-to-Worker fetch to another Worker
  // on the same account over its public workers.dev hostname
  // ("disallowed for security reasons" -- prevents fetch loops between
  // same-account Workers). A service binding bypasses that restriction
  // entirely by routing the call directly between Workers, and is the
  // architecture Cloudflare's own docs recommend for exactly this case
  // (also faster than the public round-trip it replaces). The browser
  // has no such restriction and no access to a service binding, so
  // client-side calls keep using the public API_BASE_URL exactly as
  // before -- `typeof window === "undefined"` is this file's existing
  // signal for "am I running server-side," same check every other
  // server/client-shared branch in this codebase uses, since this file
  // has no "use client" directive and is imported into both bundles.
  const fetchImpl = typeof window === "undefined" ? serverFetch : browserFetch;
  return apiRequest<T>(fetchImpl as ApiFetchFn, path, init);
}

async function browserFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

/**
 * Server-side-only request path (W.4): resolves the Cloudflare service
 * binding via getCloudflareContext() (OpenNext's documented way to reach
 * bindings from server code, see cloudflare-env.d.ts's generated `API:
 * Fetcher`) and forwards through env.API.fetch() -- a service binding's
 * exposed Fetcher, not a public URL, so no hostname/1042 concerns apply.
 * Dynamically imported so "@opennextjs/cloudflare" (a server-only
 * package) is never pulled into the client bundle that this same
 * request() function also serves -- a static top-level import would
 * fail the browser build the moment any client component imports this
 * file (every existing caller of fetchSignals/fetchFacets/etc. does).
 * Falls back to the public URL if the binding is somehow absent (e.g. a
 * local `next build` context without wrangler.jsonc's services wired
 * up) rather than throwing outright, so this never becomes a harder
 * failure mode than the public-fetch path it replaces.
 */
async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();

  const headers = { "Content-Type": "application/json", ...init?.headers };

  if (!env.API) {
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  }

  // A service binding's Fetcher.fetch() needs an absolute URL even
  // though the host portion is never actually used for routing (the
  // binding itself determines the destination Worker) -- Workers'
  // fetch() implementation still validates/parses the URL. API_BASE_URL
  // is the real production hostname, so this stays a valid, meaningful
  // URL even though the request never touches the public internet.
  return env.API.fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}

/**
 * Mirrors apps/api/src/routes/signals.ts's signalsQuerySchema exactly --
 * imported directly from @hiring-signals/domain (not hand-copied here,
 * see this file's header comment) so URL/filter state built against
 * this type can never drift from what the live route actually accepts.
 */
export type SignalListParams = Partial<SignalsQuery>;

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
  const qs = queryFromRecord(params);
  return request<SignalListResponse>(`/api/v1/signals?${qs}`, init);
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
  const qs = queryFromRecord(params);
  return request(`/api/v1/companies?${qs}`, init);
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
 * must be one of 7/14/30 (server defaults to 14). Imported from
 * @hiring-signals/domain (see this file's header comment) rather than
 * hand-declared, so it mirrors companyTimelineQuerySchema's param names
 * exactly by construction.
 */
export type CompanyTimelineParams = Partial<CompanyTimelineQuery>;

export async function fetchCompanyTimeline(
  slug: string,
  params: CompanyTimelineParams = {},
  init?: RequestInit,
): Promise<{
  data: { company: CompanySummary; buckets: CompanyHiringTimelineBucket[] };
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}> {
  const qs = queryFromRecord(params);
  return request(`/api/v1/companies/${encodeURIComponent(slug)}/timeline?${qs}`, init);
}

/**
 * GET /api/v1/trends/hiring (ROADMAP.md Milestone P.2, spec §1.2/§2.3).
 * Cross-company hiring trend ranking -- "which companies started hiring
 * X in the last N days," not one company's own timeline (that's O.1
 * above). `roles` is required server-side (>=1 role, comma-delimited);
 * `since` defaults server-side (30d-ago) when omitted. Response rows
 * carry each company's hiringVelocityScore (Milestone Q.3) alongside
 * the trend metrics. Imported from @hiring-signals/domain (see this
 * file's header comment) rather than hand-declared. `roles` stays
 * required (unlike the other Partial<...Query> aliases in this file)
 * since the route itself requires >=1 role -- every other field has a
 * server-side default and is genuinely optional from a caller's view.
 */
export type TrendsParams = Partial<TrendsQuery> & Pick<TrendsQuery, "roles">;

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
  role: string,
  init?: RequestInit,
): Promise<{
  data: {
    company: { slug: string; displayName: string };
    role: string;
    buckets: CompanyRoleActivityBucket[];
  };
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}> {
  const qs = queryFromRecord({ role });
  return request(`/api/v1/companies/${encodeURIComponent(slug)}/role-activity?${qs}`, init);
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
  const qs = queryFromRecord(params);
  return request(`/api/v1/trends/hiring?${qs}`, init);
}
