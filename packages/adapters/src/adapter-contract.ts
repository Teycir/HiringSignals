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
 */
export interface AtsAdapter {
  provider: AtsProvider;
  fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult>;
  normalize(raw: unknown, source: SourceConfig): NormalizedJob[];
}
