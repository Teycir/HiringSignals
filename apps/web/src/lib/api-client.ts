import { z } from "zod";

/**
 * Single place the browser talks to the Worker API (spec 12.1). Never call
 * ATS providers directly from a client component -- everything goes through
 * this file, which only ever hits NEXT_PUBLIC_API_BASE_URL (public by
 * design, spec 4.4 -- it's a URL, not a secret).
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

export interface SignalListParams {
  roles?: string[];
  company?: string;
  minScore?: number;
  observedSince?: string;
  sort?: "score_desc" | "newest" | "company_asc";
  cursor?: string;
  limit?: number;
}

/** GET /api/v1/signals (spec 9.2, 9.3). Phase 1 fills in real response typing. */
export async function fetchSignals(params: SignalListParams = {}) {
  const query = new URLSearchParams();
  if (params.roles?.length) query.set("roles", params.roles.join(","));
  if (params.company) query.set("company", params.company);
  if (params.minScore !== undefined) query.set("minScore", String(params.minScore));
  if (params.observedSince) query.set("observedSince", params.observedSince);
  if (params.sort) query.set("sort", params.sort);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));

  return request<{ data: unknown[]; meta: Record<string, unknown> }>(
    `/api/v1/signals?${query.toString()}`,
  );
}

/** GET /api/v1/signals/:signalId (spec 9.2). */
export async function fetchSignalDetail(signalId: string) {
  return request<{ data: unknown; meta: Record<string, unknown> }>(
    `/api/v1/signals/${encodeURIComponent(signalId)}`,
  );
}

/** GET /api/v1/facets (spec 9.2, 10.4). */
export async function fetchFacets() {
  return request<{ data: unknown; meta: Record<string, unknown> }>("/api/v1/facets");
}
