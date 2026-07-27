import { securityHeaders as securityHeaders_ } from "../../../lib/http/security-headers";

// Known Pages preview/production origins. Extend as environments are added.
// Never use "*" for authenticated endpoints (spec 13.2).
const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  // "https://hiring-signals.pages.dev",
  // "https://<production-domain>",
]);

/**
 * Thin project-specific wrapper around the generic lib helper. The generic
 * helper never hard-codes origins; this file is the one place that lists
 * them (same pattern as @hiring-signals/db re-exporting the D1 client from
 * lib/ -- project-specific wiring lives here, the reusable logic lives in
 * lib/).
 *
 * If you're changing *what* headers or the CSP default, fix it in
 * ../../../lib/http/security-headers.ts. If you're changing *which origins
 * are allowed*, edit ALLOWED_ORIGINS above.
 */
export function securityHeaders() {
  return securityHeaders_({ allowedOrigins: ALLOWED_ORIGINS });
}
