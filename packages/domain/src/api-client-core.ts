import { apiErrorSchema } from "./api-envelope";

/**
 * Platform-agnostic request/error-handling core shared by apps/web's and
 * apps/cli's API clients (ROADMAP.md refactor, 2026-08-17). Both clients
 * independently hand-rolled a near-identical `request<T>()` -- JSON parse,
 * apiErrorSchema-shaped error unwrap, ApiClientError throw -- and a
 * near-identical `queryFromRecord`/manual-URLSearchParams query builder.
 * They had already drifted once (apps/web still had its own inline copy
 * of apiErrorSchema instead of this package's) before this extraction.
 *
 * Deliberately NOT typed against DOM's `fetch`/`Response`/`RequestInit`
 * globals or Node's `@types/node` ambient fetch types: this package's
 * tsconfig (tsconfig.base.json) only sets `lib: ["ES2022"]`, and adding
 * DOM/node ambient types here would be the wrong fix even if it worked --
 * apps/api (a Cloudflare Worker) also depends on @hiring-signals/domain,
 * and Workers' own ambient fetch/Response types come from
 * @cloudflare/workers-types, a third source not necessarily structurally
 * identical to DOM's or Node's. Accepting a minimal structural
 * `ApiFetchResponse` shape (just the two methods this file actually
 * calls) instead of the real `Response` type sidesteps three-way global
 * type compatibility entirely -- any of DOM's/Node's/Workers' Response
 * satisfies this structurally, no lib changes required anywhere.
 */

export interface ApiFetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

/** Structural subset of `fetch` this file needs -- same reasoning as
 * ApiFetchResponse above. Callers pass their platform's real `fetch`
 * (or a wrapped version, e.g. apps/web's service-binding serverFetch)
 * straight through; this type only exists so this file doesn't need to
 * name the real `typeof fetch` type. */
export type ApiFetchFn = (url: string, init?: unknown) => Promise<ApiFetchResponse>;

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

/**
 * Shared GET/JSON request path: calls `fetchImpl(url, init)`, parses the
 * body as JSON, and throws ApiClientError (parsed via apiErrorSchema) on
 * a non-ok response. Network failures (fetchImpl itself rejecting) and
 * non-JSON bodies are the two failure modes apps/cli's original version
 * distinguished with dedicated error codes (NETWORK_ERROR,
 * INVALID_RESPONSE) -- preserved here since apps/web's caller (which
 * never previously distinguished them) gains nothing by losing that
 * signal, and apps/cli's callers depend on it.
 */
export async function apiRequest<T>(
  fetchImpl: ApiFetchFn,
  url: string,
  init?: unknown,
): Promise<T> {
  let res: ApiFetchResponse;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    // A cancelled fetch (AbortController.abort()) rejects with a
    // DOMException/AbortError -- re-thrown as-is, not wrapped into an
    // ApiClientError. Callers that race a request against changing
    // filter state (apps/web's signal-feed.tsx/trends-view.tsx) rely on
    // isAbortError() (api-client.ts) to distinguish "the user changed
    // filters again" from "the request genuinely failed," which checks
    // `err instanceof DOMException` -- wrapping strips that type
    // identity, so the abort fell through to the generic error path and
    // its own message ("signal is aborted without reason", the browser's
    // literal default AbortError text) was shown to the user as if it
    // were a real API failure. This file has no DOM lib (see header
    // comment) so detect structurally rather than `instanceof
    // DOMException`, which works identically across DOM/Node/Workers.
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiClientError("NETWORK_ERROR", message, "req_none");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiClientError("INVALID_RESPONSE", "Response body was not valid JSON.", "req_none");
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

/**
 * Serializes a flat params object to a query string: arrays comma-join
 * (matching every comma-delimited list param the API accepts -- roles,
 * etc.), undefined/null are skipped (so an omitted filter never becomes
 * `?key=undefined`), everything else is String()'d. Identical logic in
 * both apps/cli's and (as manual per-field URLSearchParams.set calls)
 * apps/web's original api-client.ts.
 */
export function queryFromRecord(params: Record<string, unknown>): string {
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
