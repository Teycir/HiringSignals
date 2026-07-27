/**
 * Typed bindings for the Worker, mirroring wrangler.toml.
 * Keep this in sync whenever a binding is added/renamed in wrangler.toml.
 *
 * TURNSTILE_SECRET_KEY is optional (secret env, not a binding). If missing,
 * anti-abuse middleware gracefully degrades to rate-limit-only enforcement
 * instead of returning 401s. The admin-site CAPTCHA will also still render
 * with Cloudflare's 1x0000000000000000000000000000000AA test sitekey; its
 * responses verify only when a real secret is configured.
 */
export interface Bindings {
  DB: D1Database;
  CACHE: KVNamespace;
  INGEST_QUEUE: Queue;
  ENVIRONMENT: "development" | "staging" | "production";
  TURNSTILE_SECRET_KEY?: string;
}

/** Per-request context values set by middleware (spec 13.2), e.g. requestId. */
export interface Variables {
  requestId: string;
  /** IP used for rate-limiting / abuse-signal attribution (CF-Connecting-IP, falls back to x-forwarded-for). */
  clientIp: string;
  /** Set by anti-abuse middleware so route handlers can introspect CAPTCHA/RL state. */
  abuseVerdict: "ok" | "rate_limited" | "captcha_required" | "captcha_failed" | "downgraded";
}

/** Combined Hono generic env, used as `new Hono<{ Bindings; Variables }>()`. */
export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
