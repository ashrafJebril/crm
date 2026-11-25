/**
 * SP-18 drawer keyboard rules (pure, for tests).
 *
 *  - Escape closes the drawer only when nothing inside handled it first (the
 *    `@` list marks its Escape `defaultPrevented`) and the `@` list is closed.
 *  - Ctrl/Cmd+J toggles the drawer, but not while the member is typing in an
 *    input, textarea, select or editable area outside the drawer.
 *  - Tab cycles inside the open drawer (it is aria-modal).
 */

export function shouldCloseOnEscape(e: { key: string; defaultPrevented: boolean }, suggestionOpen: boolean): boolean {
  return e.key === "Escape" && !e.defaultPrevented && !suggestionOpen;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => unknown;
}

export function isShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j";
}

/** The shortcut may toggle the drawer for this event target. */
export function shortcutAllowed(target: TargetLike | null | undefined): boolean {
  if (!target) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
  if (!editable) return true;
  // The drawer's own composer and fields may close it.
  return !!target.closest?.(".copilot-drawer");
}

/** Where Tab goes inside the drawer: wraps from the last element to the first and back. Null: leave it to the browser. */
export function trapTarget<T>(focusables: T[], active: T | null, shift: boolean): T | null {
  if (!focusables.length) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const i = active === null ? -1 : focusables.indexOf(active);
  if (i === -1) return shift ? last : first;
  if (shift && i === 0) return last;
  if (!shift && i === focusables.length - 1) return first;
  return null;
}

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Resume polling: give up after this many failed reads in a row (then show the stream_lost copy). */
export const RESUME_MAX_FAILURES = 5;
