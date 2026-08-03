import type { HTMLAttributes } from "react";

// spec 11.3: 11-12px monospace for score/timestamp/count display.
// Thin wrapper around F.2's `.data-label` CSS class (globals.css) so
// every data-point element in the app (score badges, "Observed"
// timestamps, facet counts) goes through one component instead of
// ad hoc font-size/font-family utility classes scattered across F.4/F.5.
export function DataLabel({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`data-label ${className}`.trim()} {...props} />;
}
