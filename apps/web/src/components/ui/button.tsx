import type { ButtonHTMLAttributes } from "react";

// Minimal Brutalist button (spec 11.4 table): rectangular, 2px black
// border, bold uppercase, no radius. Primary variant is the chartreuse
// accent fill with black text (the only WCAG-safe pairing -- see F.2's
// contrast check); hover inverts foreground/background instead of
// changing shape or adding shadow. Native <button> throughout for free
// keyboard operability + the F.2 global :focus-visible outline.
type ButtonVariant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const base =
  "inline-flex items-center justify-center border-2 border-ink font-display font-bold uppercase tracking-wide px-5 py-3 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-ink hover:bg-ink hover:text-accent",
  secondary: "bg-paper text-ink hover:bg-ink hover:text-paper",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`.trim()}
      {...props}
    />
  );
}
