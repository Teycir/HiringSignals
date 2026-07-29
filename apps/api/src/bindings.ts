/**
 * Typed bindings for the Worker, mirroring wrangler.toml.
 * Keep this in sync whenever a binding is added/renamed in wrangler.toml.
 *
 * No auth-related bindings: the app has no login and every `/api/v1/*`
 * route is public/unauthenticated, permanently (spec 3, 13.5, 14.1).
 * Source management (add/edit source, manual ingestion trigger, health)
 * is a local ops script against D1, not a Worker route -- see
 * infrastructure/scripts/.
 */
export interface Bindings {
  DB: D1Database;
  CACHE: KVNamespace;
  INGEST_QUEUE: Queue;
  /** Workers AI, used to generate job/query embeddings for semantic search (spec 9.4, Milestone I). */
  AI: Ai;
  /** Vectorize index `hiring-signals-jobs` (768-dim, cosine), holding one vector per job keyed on jobs.id. */
  VECTORIZE: VectorizeIndex;
  ENVIRONMENT: "development" | "staging" | "production";
  /** Workers AI model id used for embeddings; config not code, so a model swap doesn't require a redeploy of logic. */
  EMBEDDING_MODEL: string;
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
