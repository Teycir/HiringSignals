import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Spec 12.1/14.1 follow-up: replaces the static per-build CSP in
// next.config.ts's `headers()` with a per-REQUEST strict CSP.
//
// NOTE ON FILENAME: this is `proxy.ts`, not `middleware.ts`. Next.js
// 16.0.0 deprecated the `middleware.ts` file convention and renamed it
// to `proxy.ts` with a required named `proxy` export -- a leftover
// middleware.ts is silently ignored at build time (no error, no
// warning), so it would look correct in the repo while never actually
// running. This repo is on next@16.2.11, well past that cutoff, so
// `proxy.ts` + `export function proxy(...)` is the only convention Next
// will actually pick up. Do not rename this back to middleware.ts.
//
// Why this file exists at all: next.config.ts's production script-src
// was `'self'` with no 'unsafe-inline', no hash, no nonce. That's
// stricter than Next.js's own output requires -- the App Router embeds
// RSC hydration data via inline <script> tags on every response (dev AND
// prod, not just `next dev`'s HMR client), so a bare `script-src 'self'`
// blocks the app's own bootstrap. Confirmed in production via browser
// console: 6 blocked-inline-script CSP violations on /signals, followed
// by a client `Connection closed` error from the RSC stream -- hydration
// never completed, so the page never fetched data past its static shell.
//
// Nonce-based CSP is Next.js's own documented fix for this
// (https://nextjs.org/docs/app/guides/content-security-policy): generate
// a fresh, unpredictable nonce per request here, forward it via the
// `x-nonce` request header (Next reads the nonce back out of the CSP
// response header itself during SSR and auto-applies it to its own
// framework/page scripts -- no manual per-tag wiring needed for that;
// x-nonce is only needed if a Server Component wants to pass it to a
// THIRD-PARTY <Script nonce={...}>, which this app doesn't currently
// have), and echo the same nonce in the CSP response header's
// script-src. 'strict-dynamic' lets nonce'd entry scripts load their own
// child chunks without allowlisting every hashed filename by hand;
// browsers without 'strict-dynamic' support fall back to 'self'.
//
// IMPORTANT: nonce-based CSP requires every matched route to render
// DYNAMICALLY (Next parses the nonce out of the CSP header during SSR;
// a statically prerendered page has no request to read a header from).
// Verified at time of writing: no route in apps/web/src/app uses
// `export const dynamic = "force-static"` or otherwise opts into static
// generation, so this is a non-issue today -- but if a future route adds
// static generation, its Next.js-managed scripts will fail to get a
// nonce, and this proxy's `config.matcher` below (or the route itself)
// needs an explicit exclusion.
//
// This all works per-REQUEST (not per-build) because proxy.ts runs on
// every request under @opennextjs/cloudflare's Node.js-runtime Worker --
// unlike static export, there's no build-time snapshot to go stale.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // Deliberately NOT branching on process.env.NODE_ENV here. next.config.ts
  // already documents (and this repo already hit in production) that this
  // machine's shell exports an ambient NODE_ENV=production that leaks into
  // `next dev` itself, defeating any dev/prod check based on it -- and
  // proxy.ts has no access to Next's own PHASE_DEVELOPMENT_SERVER signal
  // (that's a next.config.ts-time value, not available per-request). Rather
  // than risk silently shipping the wrong branch again, this always emits
  // the strict, nonce'd policy below. The nonce makes Next's own inline
  // bootstrap/HMR scripts work in both dev and prod alike -- that's the
  // actual bug this file exists to fix -- so no dev-only relaxation is
  // needed here at all. (React's dev-mode debugging internals occasionally
  // want 'unsafe-eval'; if that specific need resurfaces, add it back
  // ONLY inside next.config.ts's existing isDev branch, which has a
  // verified-reliable phase check, never here.)
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Tailwind's arbitrary-value utilities compile to static CSS at
    // build time, not runtime style injection, but keep 'unsafe-inline'
    // here for style-src only -- React itself sets a handful of inline
    // style attributes (e.g. Framer Motion's transform/opacity) that a
    // nonce can't reach because they're element attributes, not <style>
    // tags. Nonces only gate <script>/<style> *elements*, not the
    // `style="..."` attribute, so this is the correct scoping, not a
    // leftover from the old policy.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787"}`,
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Skip static assets and image optimization: they're immutable,
// fingerprinted files that never need a nonce or a per-request CSP, and
// running this on every asset request adds latency for nothing.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
