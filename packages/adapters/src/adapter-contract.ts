import type { AtsProvider, NormalizedJob } from "@hiring-signals/domain";

/**
 * Per-source config, mirrors the `sources` table (spec 8.2) plus registry
 * shape (spec 4.2). Adapters receive this, never raw secrets.
 */
export interface SourceConfig {
  sourceId: string;
  companyId: string;
  provider: AtsProvider;
  boardToken: string;
  publicUrl: string;
}

/** Per-invocation context: user-agent, timeouts, concurrency limits (spec 4.3). */
export interface FetchContext {
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AdapterFetchResult {
  httpStatus: number;
  rawBody: unknown;
  retryAfterSeconds?: number;
}

/**
 * Every provider adapter implements this same pure, testable contract
 * (spec 5.3). fetchBoard hits only the public documented endpoint;
 * normalize is a pure function (raw -> NormalizedJob[]) so it can be
 * fixture-tested without network access.
 *
 * SSRF INVARIANT (spec 14.1's "limit outbound URL fetching to
 * adapter-defined, allow-listed hosts"): fetchBoard's request host MUST
 * always be a string literal baked into that adapter's own file (see
 * greenhouse.ts's `boardUrl()` -- `https://boards-api.greenhouse.io/...`
 * is hard-coded; only `boardToken` is interpolated, and only into a path
 * segment, always through `encodeURIComponent`). SourceConfig's fields
 * come from D1 (an operator-managed but still external-to-the-adapter
 * input) and must NEVER be used to construct a hostname/origin/scheme --
 * only path segments, query values, or body fields on an already-fixed
 * host. This is what keeps the registry's provider->adapter map
 * (registry.ts) an effective host allow-list by construction: a new
 * adapter that builds its request URL from a DB column instead of a
 * literal breaks this invariant and reopens SSRF, even if it typechecks
 * and passes fixture tests (fixtures don't cover this).
 */
export interface AtsAdapter {
  provider: AtsProvider;
  fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult>;
  normalize(raw: unknown, source: SourceConfig): NormalizedJob[];
}
