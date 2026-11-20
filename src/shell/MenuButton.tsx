import { forwardRef } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { SHELL_DRAWER_ID, setDrawerOpen, useDrawerOpen } from "./shellState";

/** SP-30: opens the shell drawer below md (topbar, inline start). */
export const MenuButton = forwardRef<HTMLButtonElement>(function MenuButton(_props, ref) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const open = useDrawerOpen();
  return (
    <button
      ref={ref}
      type="button"
      className="btn ghost icon menu-btn"
      aria-label={tx("Menu", "القائمة")}
      title={tx("Menu", "القائمة")}
      aria-expanded={open}
      aria-controls={SHELL_DRAWER_ID}
      onClick={() => setDrawerOpen(!open)}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
});
