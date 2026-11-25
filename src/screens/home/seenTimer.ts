/** The bits of `document` the seen timer needs (a fake in tests). */
export interface VisibilityDoc {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}

/**
 * Calls `fire` once the page has been visible for `delayMs` in a row: a
 * countdown interrupted by the tab going hidden starts again when it becomes
 * visible. `alreadyFired` (shared across re-arms) keeps it to at most once.
 * Returns a cancel function.
 */
export function scheduleSeen(doc: VisibilityDoc, delayMs: number, alreadyFired: () => boolean, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    if (alreadyFired() || timer !== null || doc.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      timer = null;
      if (alreadyFired() || doc.visibilityState === "hidden") return;
      fire();
    }, delayMs);
  };
  const onVisibility = () => (doc.visibilityState === "hidden" ? clear() : arm());
  doc.addEventListener("visibilitychange", onVisibility);
  arm();
  return () => {
    clear();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
