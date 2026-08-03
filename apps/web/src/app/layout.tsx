import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "HIRING//SIGNALS",
  description:
    "Public hiring-signal feed derived from job-board postings. Not a candidate database.",
};

// AppShell wraps every route at the root layout level (spec 10.2) since
// the masthead/scroll-progress are global chrome, not page-specific.
// `filters` is intentionally not passed here -- F.4's filter-rail
// content is route-specific (only /signals has filters; /signals/[id]
// in F.5 doesn't), so individual pages compose their own <aside>
// content into AppShell rather than the root layout guessing what every
// route needs.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
