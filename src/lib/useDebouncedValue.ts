import { useEffect, useState } from "react";

/** Returns a copy of `value` that only updates after `delayMs` of no
 *  changes. Useful for debouncing API-bound query strings. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
