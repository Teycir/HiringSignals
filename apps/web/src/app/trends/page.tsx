// Thin server component -- see components/trends-view.tsx's header
// comment for why the actual page content (which calls useSearchParams)
// lives there instead of here: Next requires that hook's client
// component to be wrapped in Suspense, so this file's only job is
// providing that boundary. Same pattern as app/signals/page.tsx.
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { TrendsView } from "@/components/trends-view";

export default function TrendsPage() {
  return (
    <Suspense fallback={<AppShell>{null}</AppShell>}>
      <TrendsView />
    </Suspense>
  );
}
