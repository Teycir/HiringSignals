import type {
  CompanySummary,
  Facets,
  SignalDetail,
  SignalListItem,
} from "@hiring-signals/db/src/types";
import { apiErrorSchema, type SignalsQuery } from "@hiring-signals/domain";

/**
 * Single place apps/cli talks to the Worker API (spec 12.1, ROADMAP.md
 * Milestone F.1.1). Thin client only -- no D1 access, no bypassing the
 * API's validation/rate-limiting/auth (F.1's design principle 5).
 *
 * Pattern and header-comment reasoning are carried over from the deleted
 * apps/web/src/lib/api-client.ts (git history at commit e102eeb, read
 * before writing this file per ROADMAP.md F.1's note) with two fixes
 * that file's own header called out as things it should have done:
 *  1. Imports apiErrorSchema from @hiring-signals/domain instead of
 *     hand-rolling a duplicate inline schema.
 *  2. Imports SignalsQuery from @hiring-signals/domain's signals-query.ts
 *     (moved there in this same milestone) instead of hand-maintaining a
 *     parallel SignalListParams interface that could drift from the
 *     route's actual accepted fields.
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

export class ApiClientError extends Error {
  code: string;
  requestId: string;

  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(config: CliClientConfig, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (err) {
    // Network failure (DNS, connection refused, etc.) never reached the
    // API at all -- no requestId exists to report. "req_none" makes that
    // explicit rather than fabricating one, per F.1 principle 2 (machine
    // -readable errors an agent can branch on via the `code` field).
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiClientError("NETWORK_ERROR", message, "req_none");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "Response body was not valid JSON.",
      "req_none",
    );
  }

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

function queryFromRecord(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) query.set(key, value.join(","));
      continue;
    }
    query.set(key, String(value));
  }
  return query.toString();
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

/** GET /api/v1/companies (spec 9.2, 10.4's company-combobox typeahead). */
export async function fetchCompanies(
  config: CliClientConfig,
  params: { q?: string; limit?: number } = {},
): Promise<{ data: CompanySummary[]; meta: { requestId: string; appliedFilters: Record<string, unknown> } }> {
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
): Promise<{ data: CompanyDetail; meta: { requestId: string } }> {
  return request(config, `/api/v1/companies/${encodeURIComponent(slug)}`);
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

export async function fetchSources(
  config: CliClientConfig,
  params: { companyId?: string; limit?: number } = {},
): Promise<{ data: SourceSummary[]; meta: { requestId: string; appliedFilters: Record<string, unknown> } }> {
  const qs = queryFromRecord(params);
  return request(config, `/api/v1/sources?${qs}`);
}

/**
 * GET /api/v1/export/signals.csv -- returns the raw CSV text, not JSON
 * (this is the one route that doesn't use the data/meta envelope). The
 * CLI command layer (F.1.3) is responsible for writing it to --out or
 * stdout as-is.
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
