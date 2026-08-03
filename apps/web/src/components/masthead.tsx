import { AnimatedTagline } from "@/components/animated-tagline";
import { Button } from "@/components/ui/button";
import { DataLabel } from "@/components/ui/data-label";

// spec 10.2: wordmark, last-sync timestamp, [EXPORT CSV] button. Export
// is disabled here -- Milestone L.1's export route params aren't
// threaded through yet (F landed before L.1), so this stubs the
// affordance rather than wiring a broken link. Re-enable once L.1 ships.
//
// Wraps to two rows under ~400px (spec 11.5's 320px-width check found
// the single-row layout squeezing the wordmark into a mid-word line
// break and crushing the timestamp/button into narrow columns) --
// flex-wrap plus whitespace-nowrap on the wordmark keeps
// "HIRING//SIGNALS" intact and lets the sync-label+button group drop to
// its own row instead of fighting the wordmark for width.
export function Masthead() {
  return (
    <header className="border-b-2 border-ink px-6 py-4 flex flex-wrap items-center justify-between gap-4">
      <AnimatedTagline text="HIRING//SIGNALS" className="whitespace-nowrap" />
      <div className="flex items-center gap-4">
        <DataLabel className="text-soft-ink whitespace-nowrap">last sync: pending</DataLabel>
        <Button variant="secondary" disabled title="Export ships in Milestone L.1">
          Export CSV
        </Button>
      </div>
    </header>
  );
}
