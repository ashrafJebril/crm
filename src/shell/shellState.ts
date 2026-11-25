import { useCallback, useSyncExternalStore } from "react";
import { useTweaks } from "@/tweaks/context";
import { useViewport } from "@/lib/useViewport";
import { shellMode, toggledCollapsedPref, type ShellMode } from "@/styles/breakpoints";

/**
 * SP-30 shell state: the drawer's open flag (shared by the topbar menu
 * button and the drawer host) and the current shell mode.
 */
let drawerOpen = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function setDrawerOpen(open: boolean): void {
  if (drawerOpen === open) return;
  drawerOpen = open;
  emit();
}

export function useDrawerOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => drawerOpen,
    () => false,
  );
}

export const SHELL_DRAWER_ID = "shell-drawer";

/** drawer / rail / full for this width and the remembered choice, plus the toggle. */
export function useShellMode(): { mode: ShellMode; toggle: () => void } {
  const { t, setTweak } = useTweaks();
  const { width } = useViewport();
  const mode = shellMode(width, t.sidebarCollapsed);
  const toggle = useCallback(() => {
    if (mode === "drawer") setDrawerOpen(!drawerOpen);
    else setTweak("sidebarCollapsed", toggledCollapsedPref(mode));
  }, [mode, setTweak]);
  return { mode, toggle };
}
