import Link from "next/link";
import { AppShell } from "@/components/app-shell";

// Root ("/") placeholder. The real signal feed now lives at /signals
// (app/signals/page.tsx, F.4) -- this page wraps itself in AppShell
// directly (root layout no longer renders AppShell itself, see
// layout.tsx's comment) with no `filters`, same as before.
export default function Home() {
  return (
    <AppShell>
      <div className="p-6">
        <p className="text-soft-ink">
          The signal feed lives at <Link href="/signals" className="underline">/signals</Link>.
        </p>
      </div>
    </AppShell>
  );
}
