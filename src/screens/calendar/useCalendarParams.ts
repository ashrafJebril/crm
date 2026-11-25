import { useCallback, useEffect, useState } from "react";
import { parseCalendarParams, withCalendarParams, type CalendarParams } from "./calendarParams";

/** The Schedule tab's view, date and filters in the hash (reload and Back restore them). */
export function useCalendarParams(today: string): [CalendarParams, (patch: Partial<CalendarParams>) => void] {
  const [params, setParams] = useState<CalendarParams>(() => parseCalendarParams(window.location.hash, today));
  useEffect(() => {
    const on = () => setParams(parseCalendarParams(window.location.hash, today));
    on();
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [today]);
  const set = useCallback(
    (patch: Partial<CalendarParams>) => {
      const next = withCalendarParams(window.location.hash, patch, today);
      if (next !== window.location.hash) window.location.hash = next;
      setParams(parseCalendarParams(next, today));
    },
    [today],
  );
  return [params, set];
}
