"use client";
// Signal card (spec 10.3's 9 required fields; #9 -- the OPEN PUBLIC JOB
// POST link -- belongs to the detail view/page, not the card, so this
// component covers #1-8 only). Hover mechanics ported from
// ArxivExplorer's Card.tsx (y:-3 lift, 0.18s [0.22,1,0.36,1] ease,
// corner-accent squares 4px->6px) per ROADMAP's explicit instruction --
// the mouse-tracking radial glow/blur and backdrop-blur/drop-shadow are
// deliberately NOT ported (spec 11.1 forbids glassmorphism/drop
// shadows), and corners are square (border-ink, no rounded-xl) to match
// spec 11.4's Card/row row: "white background, black separators, no
// shadow."
import { motion } from "framer-motion";
import Link from "next/link";
import type { SignalListItem } from "@hiring-signals/db/src/types";
import {
  ROLE_LABELS,
  LOCATION_MODE_LABELS,
  PROVIDER_LABELS,
  SIGNAL_TYPE_LABELS,
} from "@/lib/labels";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { DataLabel } from "./ui/data-label";

interface SignalCardProps {
  signal: SignalListItem;
}

/** Relative "time ago" for the Observed field (spec 10.3 #6: "never an
 * invented posting time" -- lastDetectedAt is the one honest timestamp
 * this shape has; there is no separate postedAt on SignalListItem). */
function formatObserved(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SignalCard({ signal }: SignalCardProps) {
  const reducedMotion = useReducedMotion();
  const isHighScore = signal.score >= 80;

  // Location/work mode line (spec 10.3 #5, nullable): SignalRow's
  // documented degrade for company-level signals means locationMode/
  // countryCode can both be null -- omit the line entirely rather than
  // rendering "null" or an empty placeholder. locationMode on
  // SignalListItem is a raw `string | null` (not validated against
  // LocationMode at the type level -- see types.ts), so a lookup miss
  // falls back to the raw DB value rather than silently rendering
  // nothing, in case the DB ever has a value the label map doesn't know.
  const locationLabel = signal.locationMode
    ? (LOCATION_MODE_LABELS as Record<string, string>)[signal.locationMode] ?? signal.locationMode
    : undefined;
  const locationLine = [locationLabel, signal.countryCode].filter(Boolean).join(" \u00B7 ");

  return (
    <motion.div
      initial={{ opacity: 1, y: 0 }}
      whileHover={
        reducedMotion ? undefined : { y: -3, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } }
      }
      className="group relative bg-paper border-2 border-ink p-4 flex flex-col gap-2"
    >
      {/* Corner accents, ported from ArxivExplorer's Card.tsx -- square
          (no rounded-xl), border-ink not neon-red, no glow. */}
      <span className="absolute top-0 left-0 w-1 h-1 border-t-2 border-l-2 border-ink group-hover:w-1.5 group-hover:h-1.5 transition-all duration-300 pointer-events-none" />
      <span className="absolute bottom-0 right-0 w-1 h-1 border-b-2 border-r-2 border-ink group-hover:w-1.5 group-hover:h-1.5 transition-all duration-300 pointer-events-none" />

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <Link
            href={`/companies/${signal.companySlug}`}
            className="font-display font-bold text-sm truncate underline"
            // Stop the card's own hover/click affordance (View evidence)
            // from being the only clickable target -- this is a second,
            // independent link within the same card, not nested inside
            // the evidence link below.
            onClick={(e) => e.stopPropagation()}
          >
            {signal.companyDisplayName}
          </Link>
          <DataLabel className="text-soft-ink">{SIGNAL_TYPE_LABELS[signal.signalType]}</DataLabel>
        </div>
        {/* Score block (spec 11.4): monospace, black-fill/white-text
            normal, chartreuse-fill/black-text at score >= 80. */}
        <DataLabel
          className={`shrink-0 px-2 py-1 font-bold ${
            isHighScore ? "bg-accent text-ink" : "bg-ink text-paper"
          }`}
        >
          {signal.score}
        </DataLabel>
      </div>

      <p className="font-display text-sm">{signal.headline}</p>

      <DataLabel className="flex flex-wrap items-center gap-x-3 gap-y-1 text-soft-ink">
        <span>{ROLE_LABELS[signal.roleCategory]}</span>
        {locationLine && <span>{locationLine}</span>}
        {signal.sourcePlatform && (
          <span>{(PROVIDER_LABELS as Record<string, string>)[signal.sourcePlatform] ?? signal.sourcePlatform}</span>
        )}
        <span>{formatObserved(signal.lastDetectedAt)}</span>
      </DataLabel>

      <Link
        href={`/signals/${signal.id}`}
        className="font-display text-sm font-bold uppercase tracking-wide underline self-start mt-1"
      >
        View evidence &rarr;
      </Link>
    </motion.div>
  );
}
