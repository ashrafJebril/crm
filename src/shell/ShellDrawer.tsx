import { useRef, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useDialogFocus } from "@/lib/useDialogFocus";
import { IconX } from "@/icons";
import { SHELL_DRAWER_ID } from "./shellState";

/**
 * SP-30: the sidebar as an off-canvas drawer below md. Mounted only while
 * open. A modal dialog: it slides in from the inline start (the right in
 * Arabic), traps focus, closes on Escape or a scrim tap, locks the page
 * scroll, and returns focus to the opener (the menu button) when it closes
 * (useDialogFocus). The host closes it on route change and marks the main
 * content `inert`.
 */
export function ShellDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(panelRef, true, onClose, { initialFocus: closeRef, lockScroll: true });

  return (
    <>
      <div className="shell-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        id={SHELL_DRAWER_ID}
        className="shell-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={tx("Menu", "القائمة")}
        dir={t.lang === "ar" ? "rtl" : "ltr"}
      >
        <button ref={closeRef} type="button" className="btn ghost icon shell-drawer-close" aria-label={tx("Close menu", "إغلاق القائمة")} title={tx("Close menu", "إغلاق القائمة")} onClick={onClose}>
          <IconX w={16} />
        </button>
        {children}
      </div>
    </>
  );
}
