import { useEffect, useState } from "react";
import { localDay } from "../boardQuery";

/** "YYYY-M-D" of today in `tz`; changes when the local day rolls over (checked every minute and on tab focus). */
export function useLocalDayKey(tz: string): string {
  const read = () => localDay(new Date(), tz).join("-");
  const [key, setKey] = useState(read);
  useEffect(() => {
    const tick = () => setKey(read());
    tick();
    const id = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);
  return key;
}
