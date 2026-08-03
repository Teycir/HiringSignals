import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Spec 12.1/14.1: security headers + CSP for the deployed frontend origin.
// Mirrors apps/api's lib/http/security-headers.ts intent (nosniff,
// no-referrer, locked-down Permissions-Policy) but scoped for a page that
// actually renders HTML/CSS/JS (apps/api's CSP is default-src 'none'
// since it only ever returns JSON) and that talks to exactly one external
// origin: NEXT_PUBLIC_API_BASE_URL. connect-src is restricted to 'self'
// plus that API origin so a compromised/malicious dependency can't
// exfiltrate to an arbitrary host via fetch/XHR/WebSocket.
//
// API_ORIGIN is read at build time (Next.js inlines NEXT_PUBLIC_* at
// build, not at request time) -- falls back to the same localhost
// default api-client.ts uses so local dev isn't broken by a missing env
// var. Deployed builds MUST set NEXT_PUBLIC_API_BASE_URL or connect-src
// silently falls back to localhost and every API call breaks under CSP.
const API_ORIGIN = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

function buildCsp(isDev: boolean): string {
  return [
    "default-src 'self'",
    // Next.js/Turbopack's dev client bootstraps via inline <script> tags
    // for HMR and RSC wiring -- a strict script-src 'self' blocks them
    // outright (confirmed via F.2 browser verification: blocked
    // inline-script CSP violations cascaded into a client InvariantError
    // under next dev). 'unsafe-eval' is separately required by React's
    // dev-mode debugging machinery (stack-trace reconstruction) -- React
    // itself confirms this is dev-only and never used in production
    // builds. Both are scoped to development ONLY; production keeps the
    // strict policy the deployed origin ships with.
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Tailwind's runtime style injection needs this
    "img-src 'self' data:",
    `connect-src 'self' ${API_ORIGIN}`,
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

// Config is a function of `phase` rather than a static object: this
// machine's shell has NODE_ENV=production set ambiently even when
// running `next dev` (see the "non-standard NODE_ENV" warning Next.js
// itself prints), so process.env.NODE_ENV can't be trusted to detect
// dev mode -- it would silently ship the strict prod CSP under `next
// dev` and reintroduce the exact inline-script breakage this fix
// exists to prevent. PHASE_DEVELOPMENT_SERVER is Next.js's own,
// environment-independent signal for "this is `next dev`".
export default function nextConfig(phase: string): NextConfig {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  const CSP = buildCsp(isDev);

  return {
    // Pin the workspace root explicitly: a stray lockfile elsewhere on
    // the machine (outside this repo) would otherwise make Next.js
    // guess wrong.
    turbopack: {
      root: path.join(__dirname, "..", ".."),
    },

    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "Permissions-Policy", value: "geolocation=(), camera=(), microphone=()" },
            { key: "Content-Security-Policy", value: CSP },
          ],
        },
      ];
    },
  };
}
