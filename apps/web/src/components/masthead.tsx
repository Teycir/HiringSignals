import Link from "next/link";
import { AnimatedTagline } from "@/components/animated-tagline";
import { DataLabel } from "@/components/ui/data-label";
import { ExportButton } from "@/components/export-button";

// spec 10.2: wordmark, last-sync timestamp, [EXPORT CSV] button (Milestone L.2).
// Also carries a /trends nav link (Milestone P.3) -- the only other
// top-level route besides /signals, so a single text link in the
// masthead is proportionate; a fuller nav component isn't warranted
// for two routes.
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
      <div className="flex items-center gap-4">
        <AnimatedTagline text="HIRING//SIGNALS" className="whitespace-nowrap" />
        <Link
          href="/trends"
          className="font-display text-sm font-bold uppercase tracking-wide underline whitespace-nowrap"
        >
          Trends
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <DataLabel className="text-soft-ink whitespace-nowrap">last sync: pending</DataLabel>
        <ExportButton />
      </div>
    </header>
  );
}

