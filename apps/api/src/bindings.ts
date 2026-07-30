/**
 * Typed bindings for the Worker, mirroring wrangler.toml.
 * Keep this in sync whenever a binding is added/renamed in wrangler.toml.
 *
 * Public `/api/v1/*` routes (signals, companies, sources, facets) are
 * unauthenticated, permanently (spec 3, 14.1). The only credentialed
 * surface is `/api/v1/admin/*`, gated by the shared ADMIN_SECRET binding
 * (wrangler secret, NOT committed to wrangler.toml) plus per-IP abuse
 * logging in ABUSE_LOGS — see middleware/admin-auth.ts and the
 * fail-closed policy there.
 *
 * Source write-path management (add/edit source) still lives as a local
 * ops script against D1 (infrastructure/scripts/, spec §13.5); admin
 * routes only expose the scheduling surfaces as idempotent triggers.
 */
export interface Bindings {
  DB: D1Database;
  /** Ephemeral shared KV: facet cache, rate-limit counters.
   *  Abuse audit logs live in ABUSE_LOGS (separate namespace); raw ATS
   *  payloads in RAW_PAYLOADS — see project KV namespacing rule. */
  CACHE: KVNamespace;
  /** Raw ATS board-response archive (30-day TTL). Separate namespace per
   *  security review finding CWE-668: IAM can restrict reads to ops-only
   *  without exposing CACHE-scope secrets or vice-versa. */
  RAW_PAYLOADS: KVNamespace;
  /** Append-only abuse/audit event log (14-day TTL). Separate namespace
   *  so IAM can grant abuse-dashboard read access without leaking cache
   *  counters or raw ATS payload contents. */
  ABUSE_LOGS: KVNamespace;
  INGEST_QUEUE: Queue;
  /** Workers AI, used to generate job/query embeddings for semantic search (spec 9.4, Milestone I). */
  AI: Ai;
  /** Vectorize index `hiring-signals-jobs` (768-dim, cosine), holding one vector per job keyed on jobs.id. */
  VECTORIZE: VectorizeIndex;
  ENVIRONMENT: "development" | "staging" | "production";
  /** Workers AI model id used for embeddings; config not code, so a model swap doesn't require a redeploy of logic. */
  EMBEDDING_MODEL: string;
  /** Fail-closed shared admin secret. Set via `wrangler secret put ADMIN_SECRET`.
   *  MUST NEVER be committed to wrangler.toml or any repo file. Unset = every
   *  admin route returns 403 regardless of request headers. */
  ADMIN_SECRET: string;
}

/** Per-request context values set by middleware (spec 13.2), e.g. requestId. */
export interface Variables {
  requestId: string;
  /** IP used for rate-limiting / abuse-signal attribution (CF-Connecting-IP, falls back to x-forwarded-for). */
  clientIp: string;
  /** Set by the rate-limit middleware so route handlers can introspect state. */
  abuseVerdict: "ok" | "rate_limited";
}

/** Combined Hono generic env, used as `new Hono<{ Bindings; Variables }>()`. */
export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
