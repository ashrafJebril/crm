import { useEffect, useRef, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconX } from "@/icons";
import { SHELL_DRAWER_ID } from "./shellState";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * SP-30: the sidebar as an off-canvas drawer below md. Mounted only while
 * open. A modal dialog: it slides in from the inline start (the right in
 * Arabic), traps focus, closes on Escape or a scrim tap, locks the page
 * scroll, and returns focus to the opener (the menu button) when it closes.
 * The host closes it on route change and marks the main content `inert`.
 */
export function ShellDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The opener, captured once at the first render (StrictMode re-runs effects
  // after focus has already moved into the drawer).
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    const opener = openerRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An inner popover, list or a stacked dialog (the copilot drawer) took it.
        if (e.defaultPrevented) return;
        const active = document.activeElement;
        if (active && active !== document.body && panelRef.current && !panelRef.current.contains(active)) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // After the host lifts `inert` from the main content (its effect runs after this cleanup).
      // Only once the drawer is really gone (not a StrictMode effect re-run).
      if (opener)
        window.setTimeout(() => {
          if (!document.getElementById(SHELL_DRAWER_ID) && opener.isConnected) opener.focus();
        }, 0);
    };
  }, []);

  return (
    <>
      <div className="shell-scrim" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={panelRef}
        id={SHELL_DRAWER_ID}
        className="shell-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={tx("Menu", "القائمة")}
        dir={t.lang === "ar" ? "rtl" : "ltr"}
      >
        <button ref={closeRef} type="button" className="btn ghost icon shell-drawer-close" aria-label={tx("Close menu", "إغلاق القائمة")} title={tx("Close menu", "إغلاق القائمة")} onClick={() => onCloseRef.current()}>
          <IconX w={16} />
        </button>
        {children}
      </div>
    </>
  );
}
