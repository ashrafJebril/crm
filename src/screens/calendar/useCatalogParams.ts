import { useCallback, useEffect, useState } from "react";
import { parseCatalogParams, withCatalogParams, type CatalogParams } from "./catalogParams";

/** The calendar's tab/search state, kept in the hash (back/forward and links work). */
export function useCatalogParams(): [CatalogParams, (patch: Partial<CatalogParams>) => void] {
  const [params, setParams] = useState<CatalogParams>(() => parseCatalogParams(window.location.hash));
  useEffect(() => {
    const on = () => setParams(parseCatalogParams(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const set = useCallback((patch: Partial<CatalogParams>) => {
    const next = withCatalogParams(window.location.hash, patch);
    // Typing in search replaces the entry instead of stacking history.
    if (next !== window.location.hash) {
      if (patch.q !== undefined && patch.tab === undefined) window.history.replaceState(null, "", next);
      else window.location.hash = next;
    }
    setParams(parseCatalogParams(next));
  }, []);
  return [params, set];
}
