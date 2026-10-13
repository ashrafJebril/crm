import { useSyncExternalStore } from "react";

// Whether the embedded CRM is currently shown to the user. The Tiremall admin
// may preload it in a hidden iframe; side effects like auto-marking the newest
// conversation read must wait until it is actually visible. Non-embedded = visible.
let visible = true;
const listeners = new Set<() => void>();

export function getEmbedVisible(): boolean {
  return visible;
}

export function setEmbedVisible(v: boolean): void {
  if (v === visible) return;
  visible = v;
  listeners.forEach((l) => l());
}

export function useEmbedVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getEmbedVisible,
    () => true,
  );
}

/** Auto-select the first conversation only when visible, nothing is active, and the list is non-empty. */
export function shouldAutoSelect(
  visible: boolean,
  activeId: string | null,
  conversations: readonly unknown[],
): boolean {
  return visible && activeId === null && conversations.length > 0;
}
