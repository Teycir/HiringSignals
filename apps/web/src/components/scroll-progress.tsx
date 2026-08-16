"use client";
// Ported near-verbatim from ArxivExplorer's app/components/ScrollProgress.tsx
// (itself ported from SeekYou). Scroll-fraction state drives a plain CSS
// scaleX transform via inline style -- no framer-motion involved here,
// unlike Card/AnimatedTagline, so reduced-motion is handled by simply
// not animating the transform (jumping straight to the final value)
// rather than branching framer-motion props.
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/lib/use-reduced-motion";

export function ScrollProgress() {
  const [progress, setProgress] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const update = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? scrollTop / docHeight : 0);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <div
      className="scroll-progress"
      style={{
        transform: `scaleX(${progress})`,
        // globals.css's prefers-reduced-motion block already zeroes CSS
        // transition-duration globally, but this element sets transform
        // via inline style on every scroll event rather than a CSS
        // transition, so there's no continuous animation to suppress --
        // reducedMotion is read here only so a future switch to a CSS
        // transition (e.g. for smoothing) doesn't silently reintroduce
        // motion without a guard already in place.
        transition: reducedMotion ? "none" : undefined,
      }}
    />
  );
}
