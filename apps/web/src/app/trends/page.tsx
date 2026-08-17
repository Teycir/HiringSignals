// Thin server component -- see components/trends-view.tsx's header
// comment for why the actual page content (which calls useSearchParams)
// lives there instead of here: Next requires that hook's client
// component to be wrapped in Suspense, so this file's only job is
// providing that boundary. Same pattern as app/signals/page.tsx.
import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { TrendsView } from "@/components/trends-view";

// See app/signals/page.tsx's metadata comment -- same reasoning, this
// route previously fell back to the root layout's generic title/
// description with nothing describing what /trends actually shows.
export const metadata: Metadata = {
  title: "Hiring Trends",
  description:
    "Companies ranked by hiring pace and acceleration across the roles you select -- spot who's ramping up before it shows up on aggregator boards.",
};

export default function TrendsPage() {
  return (
    <Suspense fallback={<AppShell>{null}</AppShell>}>
      <TrendsView />
    </Suspense>
  );
}
