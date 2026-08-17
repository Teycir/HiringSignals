"use client";
// Ported from ArxivExplorer's app/components/AnimatedTagline.tsx, with
// the neon-red color-shift/text-shadow hover glow removed -- spec 11.1
// explicitly forbids glassmorphism/glow effects for this product's
// Minimal Brutalist aesthetic. Kept: the per-character opacity
// stagger-in on mount, which is the only motion spec 11.1 doesn't rule
// out. Hover now only does a plain 2px lift (no color/shadow change),
// gated by useReducedMotion like every other framer-motion component
// in F.3.
import { motion } from "framer-motion";
import { useReducedMotion } from "@/lib/use-reduced-motion";

export function AnimatedTagline({ text, className = "" }: { text: string; className?: string }) {
  const chars = text.split("");
  const reducedMotion = useReducedMotion();

  // cursor-default is the base/standalone-usage default; a caller that
  // wraps this in a link (e.g. masthead.tsx's home link) passes its own
  // cursor-* class via `className`, which must win -- so cursor-default
  // only applies when the caller didn't already specify a cursor.
  const hasCursorOverride = /\bcursor-\S+/.test(className);

  return (
    <p
      className={`font-display text-sm font-bold uppercase tracking-wide text-ink ${hasCursorOverride ? "" : "cursor-default"} ${className}`.trim()}
    >
      {chars.map((char, i) => (
        <motion.span
          key={i}
          className="inline-block"
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : { duration: 0.1, delay: (chars.length - 1 - i) * 0.04 }
          }
          whileHover={reducedMotion ? undefined : { y: -2, transition: { duration: 0.15 } }}
        >
          {char === " " ? "\u00A0" : char}
        </motion.span>
      ))}
    </p>
  );
}
