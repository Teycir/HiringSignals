import type {
  CompanyHiringTimelineBucket,
  CompanySummary,
  Facets,
  HiringTrendCompany,
  JobDetail,
  JobListItem,
  SignalDetail,
  SignalListItem,
} from "@hiring-signals/db/src/types";
import {
  apiErrorSchema,
  apiRequest,
  queryFromRecord,
  ApiClientError,
  type ApiFetchFn,
  type CompanyTimelineQuery,
  type JobsQuery,
  type SignalsQuery,
  type TrendsQuery,
} from "@hiring-signals/domain";

/**
 * Single place apps/cli talks to the Worker API (spec 12.1, ROADMAP.md
 * Milestone F.1.1). Thin client only -- no D1 access, no bypassing the
 * API's validation/rate-limiting/auth (F.1's design principle 5).
 *
 * The request/error-envelope/query-string plumbing lives in
 * @hiring-signals/domain's api-client-core.ts (shared with apps/web's
 * api-client.ts, ROADMAP.md refactor 2026-08-17) -- this file only adds
 * what's genuinely apps/cli-specific: env-var config resolution,
 * HS_ADMIN_SECRET-bearing admin POSTs, and the per-route fetchers'
 * response-shape typings.
 *
 * Types come from "@hiring-signals/db/src/types", NOT the package root
 * ("@hiring-signals/db") -- same reasoning as apps/web's version: the
 * root barrel re-exports signals-repo.ts/companies-repo.ts/etc., which
 * import D1Client (ambient D1Database type from @cloudflare/workers-types,
 * a devDependency of packages/db, not apps/cli). tsc resolves a module's
 * full type graph even for `import type`-only usage, so importing the
 * root barrel would fail apps/cli's typecheck the same way it would have
 * failed apps/web's. This file must never import a *value* from
 * @hiring-signals/db either, since apps/cli has no D1 binding.
 */

const API_BASE_URL_DEFAULT = "http://localhost:8787";

export interface CliClientConfig {
  baseUrl: string;
  adminSecret?: string;
}

/**
 * Resolves base URL / admin secret from env vars, never an interactive
 * prompt (F.1 design principle 3). `--config` flag support (a JSON file
 * path) is intentionally deferred past F.1.1 -- env vars alone satisfy
 * "never an interactive login flow" and keep this subtask's scope tight.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliClientConfig {
  return {
    baseUrl: env.HS_API_BASE_URL ?? API_BASE_URL_DEFAULT,
    adminSecret: env.HS_ADMIN_SECRET,
  };
}

export { ApiClientError };

function request<T>(config: CliClientConfig, path: string, init?: RequestInit): Promise<T> {
  return apiRequest<T>(fetch as ApiFetchFn, `${config.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

/** GET /api/v1/signals (spec 9.2, 9.3). Params validated by SignalsQuery
 * (@hiring-signals/domain) upstream in the CLI command layer, not here --
 * this function just serializes an already-validated object to a query
 * string and calls the route. */
export interface SignalListResponse {
  data: SignalListItem[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    nextCursor: string | null;
    searchMode: "keyword" | "hybrid";
  };
}

export async function fetchSignals(
  config: CliClientConfig,
  params: Partial<SignalsQuery> = {},
): Promise<SignalListResponse> {
  const qs = queryFromRecord(params);
  return request<SignalListResponse>(config, `/api/v1/signals?${qs}`);
}

/** GET /api/v1/signals/:signalId (spec 9.2, 10.5). */
export async function fetchSignalDetail(
  config: CliClientConfig,
  signalId: string,
): Promise<{ data: SignalDetail; meta: { requestId: string } }> {
  return request(config, `/api/v1/signals/${encodeURIComponent(signalId)}`);
}

/** GET /api/v1/facets (spec 9.2, 10.4). */
export async function fetchFacets(
  config: CliClientConfig,
): Promise<{ data: Facets; meta: { requestId: string; cached: boolean } }> {
  return request(config, "/api/v1/facets");
}

/** GET /api/v1/companies (spec 9.2, 10.4's company-combobox typeahead).
 * Named export (not inline in fetchCompanies's return type) so
 * apps/cli/src/commands/companies.ts's --format table renderer
 * (spec §16.2) can type its parameter against this without duplicating
 * the shape -- same pattern SignalListResponse/CompanyTimelineResponse
 * already follow in this file. */
export interface CompanyListResponse {
  data: CompanySummary[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    // ROADMAP.md Milestone Q.3, spec §11.3.
    hiringVelocityDisclaimer: string;
  };
}

export async function fetchCompanies(
  config: CliClientConfig,
  params: { q?: string; limit?: number } = {},
): Promise<CompanyListResponse> {
  const qs = queryFromRecord(params);
  return request(config, `/api/v1/companies?${qs}`);
}

/** GET /api/v1/companies/:slug (spec 9.2, company page / 10.5 trend block). */
export interface CompanyDetail extends CompanySummary {
  recentSignals: SignalListItem[];
}

export async function fetchCompanyDetail(
  config: CliClientConfig,
  slug: string,
): Promise<{
  data: CompanyDetail;
  // ROADMAP.md Milestone Q.3, spec §11.3.
  meta: { requestId: string; hiringVelocityDisclaimer: string };
}> {
  return request(config, `/api/v1/companies/${encodeURIComponent(slug)}`);
}

/**
 * GET /api/v1/companies/:slug/timeline (ROADMAP.md Milestone O.1/O.2,
 * spec §1.4/§10.1). Params validated by CompanyTimelineQuery
 * (@hiring-signals/domain) upstream in the CLI command layer, same
 * pattern as fetchSignals -- this function just serializes an
 * already-validated object to a query string and calls the route.
 */
export interface CompanyTimelineResponse {
  data: { company: CompanySummary; buckets: CompanyHiringTimelineBucket[] };
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}

export async function fetchCompanyTimeline(
  config: CliClientConfig,
  slug: string,
  params: Partial<CompanyTimelineQuery> = {},
): Promise<CompanyTimelineResponse> {
  const qs = queryFromRecord(params);
  return request<CompanyTimelineResponse>(
    config,
    `/api/v1/companies/${encodeURIComponent(slug)}/timeline${qs ? `?${qs}` : ""}`,
  );
}

/**
 * GET /api/v1/companies/:slug/jobs (new -- raw per-job listing, see
 * apps/api/src/routes/companies.ts's ":slug/jobs" route for the full
 * "why this exists" rationale). Params validated by JobsQuery
 * (@hiring-signals/domain) upstream in the CLI command layer, same
 * pattern as fetchSignals/fetchCompanyTimeline.
 */
export interface JobListResponse {
  data: JobListItem[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    nextCursor: string | null;
  };
}

export async function fetchCompanyJobs(
  config: CliClientConfig,
  slug: string,
  params: Partial<JobsQuery> = {},
): Promise<JobListResponse> {
  const qs = queryFromRecord(params);
  return request<JobListResponse>(
    config,
    `/api/v1/companies/${encodeURIComponent(slug)}/jobs${qs ? `?${qs}` : ""}`,
  );
}

/** GET /api/v1/jobs/:jobId (new -- single job detail, analog to
 * fetchSignalDetail). */
export async function fetchJobDetail(
  config: CliClientConfig,
  jobId: string,
): Promise<{ data: JobDetail; meta: { requestId: string } }> {
  return request(config, `/api/v1/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * GET /api/v1/trends/hiring (ROADMAP.md Milestone P.2/P.3, spec
 * §1.2/§2.3). Params validated by TrendsQuery (@hiring-signals/domain)
 * upstream in the CLI command layer, same pattern as fetchSignals/
 * fetchCompanyTimeline -- this function just serializes an
 * already-validated object to a query string and calls the route.
 */
export interface HiringTrendsResponse {
  data: HiringTrendCompany[];
  meta: {
    requestId: string;
    appliedFilters: Record<string, unknown>;
    // snapshot-persistence-plan.md rewrite: the route no longer runs a
    // live/cached D1 query (that `cached` boolean this field replaces
    // is gone) -- every response is served from snapshots_current. This
    // is the oldest capture time among the requested roles (a multi-role
    // request can mix roles captured at slightly different times if
    // reconciliation partially failed on a prior run), or null if none
    // of the requested roles has a snapshot yet (reconciliation hasn't
    // run since deploy). See apps/api/src/routes/trends.ts's own header
    // comment.
    snapshotCapturedAt: string | null;
    // ROADMAP.md Milestone Q.3, spec §11.3 -- same disclaimer text as
    // fetchCompanyBySlug's response meta below, not duplicated per-item.
    hiringVelocityDisclaimer: string;
  };
}

export async function fetchHiringTrends(
  config: CliClientConfig,
  params: Partial<TrendsQuery> = {},
): Promise<HiringTrendsResponse> {
  const qs = queryFromRecord(params);
  return request<HiringTrendsResponse>(config, `/api/v1/trends/hiring${qs ? `?${qs}` : ""}`);
}

/** GET /api/v1/sources (no dedicated spec section beyond the route list in
 * 9.2). Shape kept local to this file rather than imported from
 * packages/db/src/sources-repo.ts, which (unlike types.ts) is not split
 * out from its D1Client-importing repo module -- importing it here would
 * reintroduce the exact ambient-D1Database typecheck failure types.ts's
 * own header comment describes and this file otherwise avoids. */
export interface SourceSummary {
  id: string;
  companyId: string;
  provider: string;
  publicUrl: string;
  enabled: boolean;
  pollIntervalMinutes: number;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

/** Named export (spec §16.2 --format table renderer, same reasoning as
 * CompanyListResponse's own comment above). */
export interface SourceListResponse {
  data: SourceSummary[];
  meta: { requestId: string; appliedFilters: Record<string, unknown> };
}

export async function fetchSources(
  config: CliClientConfig,
  params: { companyId?: string; limit?: number } = {},
): Promise<SourceListResponse> {
  const qs = queryFromRecord(params);
  return request(config, `/api/v1/sources?${qs}`);
}

/**
 * GET /api/v1/export/signals.csv -- returns the raw CSV text, not JSON
 * (this is the one route that doesn't use the data/meta envelope). The
 * CLI command layer (F.1.3) is responsible for writing it to --out or
 * stdout as-is. Not routed through the shared apiRequest/request helper
 * above since those always parse the body as JSON -- this is the one
 * fetcher across both apps/web and apps/cli that isn't, so it keeps its
 * own small fetch+error-unwrap directly.
 */
export async function fetchSignalsCsv(
  config: CliClientConfig,
  params: Partial<Omit<SignalsQuery, "sort" | "cursor" | "limit">> = {},
): Promise<string> {
  const qs = queryFromRecord(params);
  const res = await fetch(`${config.baseUrl}/api/v1/export/signals.csv?${qs}`);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiClientError("EXPORT_FAILED", `Export failed with status ${res.status}.`, "req_none");
    }
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.requestId);
    }
    throw new ApiClientError("EXPORT_FAILED", `Export failed with status ${res.status}.`, "req_none");
  }
  return res.text();
}

/**
 * Admin requests attach `Authorization: Bearer <adminSecret>` (spec 13.5,
 * apps/api/src/middleware/admin-auth.ts's token-transport contract -- no
 * query-param fallback, ever). Throws locally, before ever calling
 * fetch, if config.adminSecret is missing -- avoids sending an
 * Authorization-less request that the server would just 401 anyway, and
 * gives a clearer local error message (F.1 principle 2) than round-
 * tripping to find out.
 */
function requireAdminSecret(config: CliClientConfig): string {
  if (!config.adminSecret) {
    throw new ApiClientError(
      "MISSING_ADMIN_SECRET",
      "HS_ADMIN_SECRET is not set. Admin commands require it.",
      "req_none",
    );
  }
  return config.adminSecret;
}

function adminPost<T>(config: CliClientConfig, path: string): Promise<T> {
  const secret = requireAdminSecret(config);
  return request<T>(config, path, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
}

/** POST /api/v1/admin/sources/:sourceId/run (spec 10.5). */
export function runSource(
  config: CliClientConfig,
  sourceId: string,
): Promise<{
  data: { enqueued: boolean; sourceId: string; runId: string; companyId: string; provider: string; requestedAt: string };
  meta: { requestId: string };
}> {
  return adminPost(config, `/api/v1/admin/sources/${encodeURIComponent(sourceId)}/run`);
}

/** POST /api/v1/admin/scheduler/flush. */
export function flushScheduler(
  config: CliClientConfig,
): Promise<{
  data: { flushed: boolean; scheduledAt: string; batchLimit: number; note: string };
  meta: { requestId: string };
}> {
  return adminPost(config, "/api/v1/admin/scheduler/flush");
}

/** POST /api/v1/admin/reconcile. */
export function reconcile(
  config: CliClientConfig,
): Promise<{
  data: { reconciled: boolean; startedAt: string; batchLimit: number; note: string };
  meta: { requestId: string };
}> {
  return adminPost(config, "/api/v1/admin/reconcile");
}

/**
 * Builds the full GET /api/v1/feed.rss URL for the given filters
 * (Milestone R.3, ROADMAP.md) -- no network call, unlike every other
 * export in this file. Reuses queryFromRecord (same comma-join-array /
 * skip-null-undefined serialization every other GET in this file uses)
 * so the query string this produces is byte-identical in shape to what
 * `fetchSignals`/`fetchSignalsCsv` would send for the same params,
 * keeping drift between "the URL a human pastes into a feed reader" and
 * "the URL this CLI would call itself" impossible by construction.
 */
export function buildFeedUrl(
  config: CliClientConfig,
  params: Partial<Omit<SignalsQuery, "sort" | "cursor" | "limit">> = {},
): string {
  const qs = queryFromRecord(params);
  return `${config.baseUrl}/api/v1/feed.rss${qs ? `?${qs}` : ""}`;
}
