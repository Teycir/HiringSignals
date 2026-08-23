"use client";

import { useId, useRef, useState } from "react";

// Minimal Brutalist hover tooltip (spec 11.1/11.2/11.5 conventions:
// 2px solid black border, 0 radius, no shadow, accent used sparingly as
// a single top rule rather than a fill). Built as a standalone
// primitive -- no existing hover-info component in packages/ui/apps/web
// (the only other "Tooltip" in the codebase is trends-chart.tsx's
// Recharts data tooltip, a different concern entirely: that one shows
// a chart value on hover over a bar, this one explains what a column
// header MEANS).
//
// Icon-triggered (a small "i" glyph next to the label) rather than
// hovering the header text itself: keeps the existing sortable-header
// click target untouched and gives keyboard users a discrete
// focusable element (button) to reach via Tab, satisfying spec 11.5's
// "never mouse-only" affordance rule the rest of this app follows.
//
// Positioning: simple CSS-only absolute panel anchored below-left of
// the trigger, no floating-ui/popper dependency -- the trigger only
// ever sits inside a fixed-width table header cell, so viewport-edge
// collision isn't a real risk here the way it would be for a
// free-floating tooltip; adding a positioning library for this one
// narrow use case isn't worth the bundle weight per spec 11.3's "no
// unnecessary dependency" bias.
interface InfoTooltipProps {
  label: string;
}

export function InfoTooltip({ label }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }

  // Small delay on close only (not on open) so moving the mouse from
  // the icon onto the panel itself (to select/copy the text) doesn't
  // immediately dismiss it -- open stays instant, close has a 120ms
  // grace window.
  function hide() {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-describedby={open ? panelId : undefined}
        aria-label={`What does ${label.replace(/\s+/g, " ")} mean?`}
        className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-soft-ink font-mono text-[9px] font-bold normal-case leading-none text-soft-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-paper focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          // Header cells elsewhere in the app are click-to-sort; stop
          // that click from also toggling sort when someone taps the
          // icon on a touch device.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        i
      </button>

      {open && (
        <span
          id={panelId}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
          className="pointer-events-auto absolute left-1/2 top-full z-50 mt-2 w-48 -translate-x-1/2 border-2 border-ink bg-paper p-2.5 text-left normal-case tracking-normal text-ink shadow-[4px_4px_0_0_var(--ink)]"
        >
          <span className="mb-1.5 block h-[2px] w-5 bg-accent" aria-hidden="true" />
          <span className="block font-display text-[11px] font-normal leading-snug">{label}</span>
        </span>
      )}
    </span>
  );
}
