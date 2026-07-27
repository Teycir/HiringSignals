/**
 * Typed bindings for the Worker, mirroring wrangler.toml.
 * Keep this in sync whenever a binding is added/renamed in wrangler.toml.
 */
export interface Bindings {
  DB: D1Database;
  CACHE: KVNamespace;
  INGEST_QUEUE: Queue;
  ENVIRONMENT: "development" | "staging" | "production";
}

/** Per-request context values set by middleware (spec 13.2), e.g. requestId. */
export interface Variables {
  requestId: string;
}

/** Combined Hono generic env, used as `new Hono<{ Bindings; Variables }>()`. */
export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
