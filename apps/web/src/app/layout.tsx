import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HIRING//SIGNALS",
  description:
    "Public hiring-signal feed derived from job-board postings. Not a candidate database.",
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
