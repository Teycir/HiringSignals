import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Spec 12.1/14.1 follow-up: replaces the static per-build CSP in
// next.config.ts's `headers()` with a per-REQUEST strict CSP.
//
// FILENAME NOTE -- read before "fixing" this to proxy.ts: Next.js
// 16.0.0 did rename middleware.ts -> proxy.ts (export function proxy),
// and Next.js's own docs assume proxy.ts throughout. HOWEVER: this
// app's deploy target is @opennextjs/cloudflare (currently pinned
// 1.20.2), which does NOT yet support Next's Node.js-runtime Proxy
// convention -- confirmed by directly running
// `npx opennextjs-cloudflare build` against a proxy.ts version of this
// exact file: it failed with "File server/middleware.js does not
// exist", because the adapter's build pipeline still looks for the old
// middleware output name. This is a known, currently-open upstream gap,
// not a mistake in this file:
//   - https://github.com/cloudflare/workers-sdk/issues/13937
//   - https://github.com/cloudflare/workers-sdk/issues/13755
//   - https://github.com/opennextjs/opennextjs-cloudflare/issues/962
// All three describe this exact next@16 + opennextjs-cloudflare
// combination failing on proxy.ts, and none were resolved as of last
// check. The wider community's stopgap (see e.g.
// github.com/InumberX/after_works-v006#225) is the same one used
// here: keep the deprecated-but-still-supported middleware.ts
// convention until OpenNext ships real Proxy/Node-middleware support,
// then migrate.
//
// MIGRATION TRIGGER: once `npx opennextjs-cloudflare build` succeeds
// against a proxy.ts + `export function proxy()` version of this exact
// file (rerun the check above after any @opennextjs/cloudflare
// upgrade), rename this file to proxy.ts, rename the exported function
// to `proxy`, and delete this note. Don't migrate speculatively --
// verify the build first, the same way this note was written from a
// verified failure, not a guess.
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
// This app's root layout.tsx sets `export const dynamic = "force-dynamic"`
// for exactly this reason -- verified via
// `grep -c 'nonce=' .next/server/app/*.html` showing 0/0 on every page
// before that line was added, and every route now showing 'ƒ' (Dynamic)
// in `next build`'s route summary after it. Do not remove that layout
// export without re-verifying the nonce still lands (rebuild + grep, or
// check a live response's script tags for a nonce attribute).
//
// This all works per-REQUEST (not per-build) because middleware runs on
// every request under @opennextjs/cloudflare's Node.js-runtime Worker --
// unlike static export, there's no build-time snapshot to go stale.
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // Deliberately NOT branching on process.env.NODE_ENV here. next.config.ts
  // already documents (and this repo already hit in production) that this
  // machine's shell exports an ambient NODE_ENV=production that leaks into
  // `next dev` itself, defeating any dev/prod check based on it -- and
  // middleware has no access to Next's own PHASE_DEVELOPMENT_SERVER signal
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
