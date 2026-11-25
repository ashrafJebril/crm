import { useCallback, useEffect, useState } from "react";
import { parseInsightsParams, withInsightsParams, type InsightsParams } from "./insightsParams";

/** Analytics tab, range, number and pipeline in the hash (reload and Back restore them). */
export function useInsightsParams(): [InsightsParams, (patch: Partial<InsightsParams>) => void] {
  const [params, setParams] = useState<InsightsParams>(() => parseInsightsParams(window.location.hash));
  useEffect(() => {
    const on = () => setParams(parseInsightsParams(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const set = useCallback((patch: Partial<InsightsParams>) => {
    const next = withInsightsParams(window.location.hash, patch);
    if (next !== window.location.hash) window.location.hash = next;
    setParams(parseInsightsParams(next));
  }, []);
  return [params, set];
}
