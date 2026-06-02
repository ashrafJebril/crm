import { useEffect, useRef } from "react";
import { ensureSocket } from "./realtime";

/** Subscribe to a server-emitted socket.io event for the lifetime of the
 *  calling component. The handler may close over fresh state on every render
 *  — we keep a ref so the listener always invokes the latest version. */
export function useRealtime<T>(
  event: string,
  handler: (data: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const s = ensureSocket();
    const fn = (data: T) => handlerRef.current(data);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event]);
}
