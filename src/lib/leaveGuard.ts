/**
 * SP-29 shared leave guard. A screen with unsaved edits registers a guard
 * (it returns the confirm message while there is something to lose). Every
 * in-app navigation that swaps React state synchronously (settings tabs,
 * routes, the workspace switcher) calls `confirmLeave()` BEFORE changing
 * anything; the hashchange path only covers Back/Forward and typed URLs.
 *
 * Accepting a leave releases the current guards (the edits are being
 * discarded), so the hashchange that follows the navigation does not ask
 * again; a screen re-registers on its next edit.
 */
export type LeaveGuard = () => string | null;
export type Ask = (message: string) => boolean;

const guards = new Set<LeaveGuard>();

const defaultAsk: Ask = (m) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(m) : true);

export function registerLeaveGuard(fn: LeaveGuard): () => void {
  guards.add(fn);
  return () => {
    guards.delete(fn);
  };
}

/** The first pending message, or null when nothing would be lost. */
export function pendingLeaveMessage(): string | null {
  for (const g of guards) {
    const m = g();
    if (m) return m;
  }
  return null;
}

/** True when the navigation may go ahead (nothing pending, or the user agreed). */
export function confirmLeave(ask: Ask = defaultAsk): boolean {
  const m = pendingLeaveMessage();
  if (!m) return true;
  if (!ask(m)) return false;
  guards.clear();
  return true;
}

/** Runs `apply` only when the leave is confirmed; returns whether it ran. */
export function navigateIfAllowed(apply: () => void, ask: Ask = defaultAsk): boolean {
  if (!confirmLeave(ask)) return false;
  apply();
  return true;
}

/**
 * Back/Forward and typed URLs: the hash has already changed. When the user
 * stays, the event is stopped (the router and the settings tabs never see
 * it) and the old URL is pushed back as a new entry, so the screen and the
 * address bar agree and Back still works (it prompts again). Synthetic
 * events without an `oldURL` are never cancelled.
 */
export function guardHashChange(
  e: { oldURL?: string; stopImmediatePropagation: () => void },
  deps: { ask?: Ask; pushState?: (url: string) => void } = {},
): "allowed" | "cancelled" {
  if (!e.oldURL) return "allowed";
  if (confirmLeave(deps.ask ?? defaultAsk)) return "allowed";
  e.stopImmediatePropagation();
  (deps.pushState ?? ((url: string) => window.history.pushState(window.history.state, "", url)))(e.oldURL);
  return "cancelled";
}

/** Installs the capture-phase hashchange guard and the unload prompt (once, from the app shell or a guarded screen). */
export function installLeaveListeners(): () => void {
  const onHash = (e: HashChangeEvent) => {
    guardHashChange(e);
  };
  const onUnload = (e: BeforeUnloadEvent) => {
    const m = pendingLeaveMessage();
    if (!m) return;
    e.preventDefault();
    e.returnValue = m;
    return m;
  };
  window.addEventListener("hashchange", onHash, true);
  window.addEventListener("beforeunload", onUnload);
  return () => {
    window.removeEventListener("hashchange", onHash, true);
    window.removeEventListener("beforeunload", onUnload);
  };
}

/** Test helper. */
export function _resetLeaveGuards(): void {
  guards.clear();
}
