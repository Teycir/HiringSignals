import type { ReactNode } from "react";
import { Masthead } from "@/components/masthead";
import { ScrollProgress } from "@/components/scroll-progress";
import { Footer } from "@/components/footer";

// spec 10.2: top-level layout -- masthead + filter rail (fixed
// 280-320px desktop) + fluid content column. Mobile: filter rail
// collapses into a full-width <details>/sheet control above results
// (spec 10.2) rather than a separate mobile-only component, since
// <details> gives free keyboard/a11y semantics for the collapse state.
// Semantic landmarks per spec 11.5: header/nav/main/aside.
//
// `filters` is optional so F.3's shell can land and be verified before
// F.4's actual filter-rail component exists -- pages that don't pass
// `filters` simply render without the <aside>, rather than the shell
// depending on a component that doesn't exist yet.
interface AppShellProps {
  children: ReactNode;
  filters?: ReactNode;
}

export function AppShell({ children, filters }: AppShellProps) {
  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <ScrollProgress />
      <Masthead />
      <div className="flex flex-1 flex-col md:flex-row">
        {filters ? (
          <>
            {/* Mobile: collapsible sheet above results. */}
            <details className="md:hidden border-b-2 border-ink">
              <summary className="font-display font-bold uppercase tracking-wide px-4 py-3 cursor-pointer">
                Filters
              </summary>
              <nav aria-label="Signal filters" className="px-4 pb-4">
                {filters}
              </nav>
            </details>
            {/* Desktop: fixed-width rail. */}
            <aside className="hidden md:block md:w-[280px] lg:w-[320px] shrink-0 border-r-2 border-ink">
              <nav aria-label="Signal filters" className="p-4">
                {filters}
              </nav>
            </aside>
          </>
        ) : null}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
      {/* Footer rendered here (not in root layout.tsx) so it appears on
          every route without each page asking for it -- AppShell is the
          one wrapper every route shares. Ported from ArxivExplorer. */}
      <Footer />
    </div>
  );
}
