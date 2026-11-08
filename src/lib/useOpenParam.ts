import { useEffect, useRef } from "react";
import { getHashParam, setHashParam, splitHash } from "./hashState";

/** The `open` id of a `#/<route>?open=<id>` deep link, only when the hash is for
 *  that route (so one screen never consumes another screen's link). */
export function openParamForRoute(hash: string, route: string): string | null {
  const { path } = splitHash(hash);
  if (path.replace(/^#\/?/, "") !== route) return null;
  return getHashParam(hash, "open");
}

/** Deep-link hook: reads `?open=<id>` from the hash on mount and on every
 *  hashchange (only while the hash targets `route`), hands the id to `onOpen`,
 *  then strips the param (other params are kept) so closing the record doesn't
 *  leave a stale link behind. */
export function useOpenParam(route: string, onOpen: (id: string) => void): void {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    const check = () => {
      const id = openParamForRoute(window.location.hash, route);
      if (!id) return;
      const next = setHashParam(window.location.hash, "open", null);
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
      ref.current(id);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [route]);
}
