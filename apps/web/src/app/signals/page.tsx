// Thin server component -- see components/signals-view.tsx's header
// comment for why the actual page content (which calls useSearchParams)
// lives there instead of here: Next requires that hook's client
// component to be wrapped in Suspense, so this file's only job is
// providing that boundary.
import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { PageLoadingSkeleton } from "@/components/page-loading-skeleton";
import { SignalsView } from "@/components/signals-view";

// Root layout's title.template turns this into "Signal Feed |
// HIRING//SIGNALS". This is the app's primary entry point (/ redirects
// here), so its own title/description should describe the feed itself
// rather than falling back to the root layout's generic site
// description -- that fallback is what a crawler saw here before this
// export existed.
export const metadata: Metadata = {
  title: "Signal Feed",
  description:
    "Scored, filterable hiring signals from official ATS job-board APIs -- new roles, hiring bursts, role acceleration, and more, across 7 providers.",
};

export default function SignalsPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <PageLoadingSkeleton />
        </AppShell>
      }
    >
      <SignalsView />
    </Suspense>
  );
}
