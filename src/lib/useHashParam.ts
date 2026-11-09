import { useCallback, useEffect, useState } from "react";
import { getHashParam, setHashParam } from "./hashState";

/**
 * A hash query param (`#/channels?id=…`, `#/campaigns?id=…`), kept in sync
 * with hashchange. Setting it assigns `location.hash`, which pushes a history
 * entry, so browser Back undoes it.
 */
export function useHashParam(key: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => getHashParam(window.location.hash, key));
  useEffect(() => {
    const on = () => setValue(getHashParam(window.location.hash, key));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [key]);
  const set = useCallback(
    (v: string | null) => {
      const next = setHashParam(window.location.hash, key, v);
      if (next !== window.location.hash) window.location.hash = next;
      setValue(v);
    },
    [key],
  );
  return [value, set];
}
