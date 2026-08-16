import type { InputHTMLAttributes } from "react";
import { useId } from "react";

// spec 11.4: keyboard-operable, chartreuse fill when selected. Native
// <input type="checkbox"> gives free keyboard support (Space toggles,
// Tab focuses) and the F.2 global :focus-visible outline for free --
// visually restyled via accent-color rather than a fully custom div, so
// screen readers still see a real checkbox role/state.
interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function Checkbox({ label, id, className = "", ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={inputId}
        className={`h-4 w-4 border-2 border-ink accent-accent ${className}`.trim()}
        {...props}
      />
      <label htmlFor={inputId} className="font-display text-sm">
        {label}
      </label>
    </div>
  );
}
