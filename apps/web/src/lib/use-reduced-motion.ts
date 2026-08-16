"use client";

import { useReducedMotion as useFramerReducedMotion } from "framer-motion";

/**
 * Thin project-specific wrapper around framer-motion's own
 * useReducedMotion (spec 11.5: "Respect prefers-reduced-motion;
 * transitions under 150ms and non-essential"). Every ported
 * ArxivExplorer component (Card's hover lift, ScrollProgress's bar,
 * AnimatedTagline's stagger-in -- see F.3) must call this and branch its
 * animation props on the result, not just rely on globals.css's CSS-level
 * media-query backstop, since that backstop only zeroes out CSS
 * transition/animation durations -- it can't stop a framer-motion
 * component's JS-driven `animate`/`whileHover` logic from running.
 *
 * Kept as a wrapper (not a raw import from framer-motion everywhere) so
 * if the project later migrates to the renamed `motion/react` package
 * (see F.1's install note), the import only needs to change in one file.
 */
export function useReducedMotion(): boolean {
  return useFramerReducedMotion() ?? false;
}
