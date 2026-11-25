import { useSyncExternalStore } from "react";
import { BP, layoutFor, type Layout } from "@/styles/breakpoints";

/**
 * SP-30: the viewport, for layout logic CSS cannot express (the shell
 * drawer, inbox pane switching). One `matchMedia` listener per breakpoint,
 * shared by every caller through a module-level store; components re-render
 * only when a breakpoint is crossed. Browser only (SSR/tests get desktop).
 */
export interface Viewport {
  width: number;
  layout: Layout;
}

const FALLBACK: Viewport = { width: 1440, layout: "wide" };
let current: Viewport = FALLBACK;
const listeners = new Set<() => void>();
let installed = false;

function read(): Viewport {
  const width = typeof window === "undefined" ? FALLBACK.width : window.innerWidth;
  return { width, layout: layoutFor(width) };
}

function install() {
  if (installed || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  installed = true;
  current = read();
  for (const n of Object.values(BP)) {
    const mq = window.matchMedia(`(min-width: ${n}px)`);
    mq.addEventListener("change", () => {
      current = read();
      for (const l of listeners) l();
    });
  }
}

function subscribe(fn: () => void) {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): Viewport {
  install();
  return current;
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot, () => FALLBACK);
}
