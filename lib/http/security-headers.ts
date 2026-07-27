/**
 * Baseline security-header + CORS middleware for a Hono app.
 *
 * Sends restrictive defaults (deny-by-default CSP, no referrer leakage,
 * no unnecessary browser feature grants) and only reflects
 * Access-Control-Allow-Origin for an explicit allowlist -- never "*" for
 * anything that isn't a fully public, unauthenticated endpoint, since a
 * wildcard origin combined with credentialed requests is a common source
 * of cross-origin data leaks.
 *
 * Zero project-specific dependencies beyond Hono's MiddlewareHandler type
 * -- copy this file into any Hono-based Cloudflare Worker and pass your
 * own allowed origins.
 */

import type { MiddlewareHandler } from "hono";

export interface SecurityHeadersOptions {
  /** Exact origins allowed to receive Access-Control-Allow-Origin. No wildcard support by design. */
  allowedOrigins: Iterable<string>;
  /** Defaults to "default-src 'none'; frame-ancestors 'none'" -- override for apps that serve HTML/assets. */
  contentSecurityPolicy?: string;
  /** Defaults to "GET,POST,PATCH,OPTIONS". */
  allowedMethods?: string;
  /** Defaults to "Content-Type, Authorization". */
  allowedHeaders?: string;
}

export function securityHeaders(options: SecurityHeadersOptions): MiddlewareHandler {
  const allowedOrigins = new Set(options.allowedOrigins);
  const csp = options.contentSecurityPolicy ?? "default-src 'none'; frame-ancestors 'none'";
  const methods = options.allowedMethods ?? "GET,POST,PATCH,OPTIONS";
  const headers = options.allowedHeaders ?? "Content-Type, Authorization";

  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && allowedOrigins.has(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }

    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    c.header("Content-Security-Policy", csp);

    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", methods);
      c.header("Access-Control-Allow-Headers", headers);
      return c.body(null, 204);
    }

    await next();
  };
}
