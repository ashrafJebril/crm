import { useEffect, useRef } from "react";
import { getHashParam, setHashParam } from "./hashState";

/** Deep-link hook: reads `?open=<id>` from the hash on mount and on every
 *  hashchange, hands the id to `onOpen`, then strips the param (other params
 *  are kept) so closing the record doesn't leave a stale link behind. */
export function useOpenParam(onOpen: (id: string) => void): void {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    const check = () => {
      const id = getHashParam(window.location.hash, "open");
      if (!id) return;
      const next = setHashParam(window.location.hash, "open", null);
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
      ref.current(id);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
}
