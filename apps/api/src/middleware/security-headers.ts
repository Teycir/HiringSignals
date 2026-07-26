import type { MiddlewareHandler } from "hono";

// Known Pages preview/production origins. Extend as environments are added.
// Never use "*" for authenticated endpoints (spec 13.2).
const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  // "https://hiring-signals.pages.dev",
  // "https://<production-domain>",
]);

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }

    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );

    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return c.body(null, 204);
    }

    await next();
  };
}
