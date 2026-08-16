import type { InputHTMLAttributes } from "react";
import { useId } from "react";

// spec 11.4: white bg, 2px black border, square corners. Explicit
// <label> above the field, not placeholder-as-label -- placeholder text
// disappears on input and fails a11y (spec 11.5), so `label` is a
// required prop, not optional decoration.
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function Input({ label, id, className = "", ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-display text-sm font-bold uppercase tracking-wide">
        {label}
      </label>
      <input
        id={inputId}
        className={`bg-paper text-ink border-2 border-ink px-3 py-2 font-display ${className}`.trim()}
        {...props}
      />
    </div>
  );
}
