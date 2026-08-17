import path from "node:path";
import type { NextConfig } from "next";

// Spec 12.1/14.1: static security headers for the deployed frontend
// origin (nosniff, no-referrer, locked-down Permissions-Policy). Mirrors
// apps/api's lib/http/security-headers.ts intent, minus CORS (this is a
// same-origin HTML app, not an API).
//
// Content-Security-Policy deliberately does NOT live here anymore. It
// used to (see git history), but a CSP header set in next.config.ts's
// headers() is baked in at BUILD time and identical on every response --
// which cannot express a nonce, since a nonce is only meaningful when
// it's fresh per REQUEST. That static policy shipped
// `script-src 'self'` with no nonce/hash/unsafe-inline in production,
// which blocks the inline <script> tags Next.js's own App Router embeds
// on every response (RSC hydration payload) -- confirmed in production
// via browser console: 6 blocked-inline-script CSP violations on
// /signals, hydration never completing, page stuck on its static shell.
//
// The fix (per Next.js's own docs:
// https://nextjs.org/docs/app/guides/content-security-policy) is to
// generate the CSP header per-request in middleware.ts, where a fresh
// nonce can be minted and threaded through. See middleware.ts for the
// actual policy and the full reasoning. Do not re-add
// Content-Security-Policy to the headers() list below -- that would
// either silently do nothing (middleware's per-request header wins) or,
// if middleware.ts is ever removed, silently reintroduce this exact bug.
export default function nextConfig(): NextConfig {
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
          ],
        },
      ];
    },
  };
}
