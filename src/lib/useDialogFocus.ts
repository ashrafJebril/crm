import { useEffect, useRef, type RefObject } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * SP-30 modal focus for drawers and sheets: while `active`, focus moves into
 * the panel (the `initialFocus` element or its first control), Tab stays
 * inside, Escape closes (unless an inner control or a stacked dialog took it:
 * `defaultPrevented`, or focus is outside the panel), the page scroll can be
 * locked, and on close focus returns to the element that had it on opening.
 *
 * The opener is captured during the render that first sees `active`, so a
 * StrictMode effect re-run (focus already inside) never overwrites it, and
 * focus only returns once the panel is really closed.
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
  opts: { initialFocus?: RefObject<HTMLElement | null>; lockScroll?: boolean } = {},
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openerRef = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== "undefined") {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasActive.current = active;
  const initialFocus = opts.initialFocus;
  const lockScroll = opts.lockScroll === true;

  useEffect(() => {
    if (!active) return;
    const opener = openerRef.current;
    const prevOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";
    const first = initialFocus?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        const a = document.activeElement;
        if (a && a !== document.body && !panel.contains(a)) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const a = document.activeElement;
      if (e.shiftKey && (a === firstEl || !panel.contains(a))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (a === lastEl || !panel.contains(a))) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (lockScroll) document.body.style.overflow = prevOverflow;
      // Deferred: the host may lift `inert` after this cleanup. Only when the
      // panel is really closed (not a StrictMode re-run of this effect).
      if (opener)
        window.setTimeout(() => {
          const closed = !activeRef.current || !panelRef.current || !panelRef.current.isConnected;
          if (closed && opener.isConnected) opener.focus();
        }, 0);
    };
  }, [active, lockScroll, initialFocus, panelRef]);
}
