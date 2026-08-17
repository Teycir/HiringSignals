import type { Metadata } from "next";
import "./globals.css";

// Force every route in the app to render dynamically (per request), not
// statically at build time. Required by proxy.ts's nonce-based CSP:
// Next.js can only stamp its own inline bootstrap/hydration <script>
// tags with the request's nonce during server-side rendering, since a
// nonce is only meaningful when it's fresh per request -- a statically
// prerendered page has no request to read a nonce from, so its inline
// scripts ship with no nonce attribute at all and get silently blocked
// by the CSP (verified directly: `grep -c 'nonce=' .next/server/app/*.html`
// showed 0 across every page, static or not, before this line was added).
// `dynamic` set here in the root layout propagates to every child route
// automatically, including any page added in the future -- the
// alternative (setting `export const dynamic` in each page.tsx
// individually) is the kind of per-file convention that's one missed
// file away from silently regressing this exact bug on whatever page
// gets added next.
//
// Cost: no static generation, ISR, or CDN caching for any route. That's
// an accepted, explicit tradeoff for a small, low-traffic public
// dashboard -- not an oversight. If this app's growth trajectory ever
// makes that cost real, the alternative isn't per-page dynamic exports;
// it's Next's experimental Subresource-Integrity CSP mode
// (next.config.ts's `experimental.sri`), which allows static generation
// with a strict CSP but requires re-verifying its behavior against
// whatever Next.js version is current at that time, since it's
// explicitly unstable.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // `title.template` lets every route's own `metadata.title` (or
  // `generateMetadata`'s returned title) slot into "%s | HIRING//SIGNALS"
  // automatically -- individual pages only need to set a short, specific
  // title (e.g. "FAQ", a company's display name), not repeat the site
  // name every time. `default` is what renders here at the root and for
  // any route that doesn't set its own title at all.
  title: {
    template: "%s | HIRING//SIGNALS",
    default: "HIRING//SIGNALS",
  },
  description:
    "Public hiring-signal feed derived from job-board postings. Not a candidate database.",
  metadataBase: new URL("https://hiring-signals-web.teycircoder14.workers.dev"),
};

// AppShell is NOT rendered here (changed from F.3): each route now wraps
// its own content in <AppShell> instead. Masthead/scroll-progress stay
// global chrome since every route still renders AppShell, just one level
// down -- the reason to move it is that AppShell's `filters` prop can
// only be set by whoever instantiates <AppShell>, and F.4's filter-rail
// content is route-specific (only /signals has filters; /signals/[id]
// in F.5 doesn't). A page can't inject a prop into a shell instantiated
// by an ancestor layout it doesn't control, so rendering AppShell once
// here with no `filters` would have made it permanently impossible for
// any child route to ever pass one in. This root layout is intentionally
// thin: html/body chrome only.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
