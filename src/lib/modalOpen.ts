/** True when an `aria-modal="true"` dialog other than `self` is mounted. Lets a
 *  layer that closes on Escape defer to a dialog stacked above it. */
export function anotherModalOpen(self: Element | null): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== self);
}
