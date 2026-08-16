"use client";

import { useEffect, useState } from "react";

/**
 * Returns `value`, but only after it has stopped changing for `delayMs`.
 * Generic on purpose -- not combobox-specific -- so any future
 * rapidly-changing input this app needs to debounce (e.g. Milestone
 * I.4's free-text search box) can reuse it instead of re-implementing
 * the same setTimeout/cleanup pattern inline.
 *
 * spec 12.2: "Debounce free-text company search at approximately 250ms."
 * company-combobox.tsx is the current sole caller and passes 250.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
