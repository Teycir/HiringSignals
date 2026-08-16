// Thin server component -- see components/signals-view.tsx's header
// comment for why the actual page content (which calls useSearchParams)
// lives there instead of here: Next requires that hook's client
// component to be wrapped in Suspense, so this file's only job is
// providing that boundary.
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { SignalsView } from "@/components/signals-view";

export default function SignalsPage() {
  return (
    <Suspense fallback={<AppShell>{null}</AppShell>}>
      <SignalsView />
    </Suspense>
  );
}
