import { isOpaqueThreadId } from "./recordLink";
import { isRecordKind, parseRecordParam, recordNavTarget, type RecordKind } from "./recordParam";

// Safari and Firefox (macOS) do not focus a button on click, so document.activeElement
// is useless as "the opener". Track the last pointer target instead.
let lastPointerTarget: HTMLElement | null = null;
let pendingOpener: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>("button, a[href], [tabindex]") : null;
      lastPointerTarget = t;
    },
    true,
  );
}

/** The element that opened the sheet, consumed once by the host. */
export function takeOpener(): HTMLElement | null {
  const el = pendingOpener;
  pendingOpener = null;
  return el;
}

/** Open a record in the universal sheet over the current screen. Assigning the
 *  hash pushes a history entry, so Back returns to whatever was open before.
 *  Opaque FB/IG thread ids are not records and go to the inbox deep link. */
export function openRecord(kind: RecordKind | string, id: string): void {
  if (!id || !isRecordKind(kind)) return;
  if (kind === "conversation" && isOpaqueThreadId(id)) {
    window.location.hash = `#/inbox?open=${encodeURIComponent(id)}`;
    return;
  }
  const next = recordNavTarget(window.location.hash, { kind, id });
  if (!next) return;
  if (!parseRecordParam(window.location.hash)) {
    const a = document.activeElement;
    pendingOpener = lastPointerTarget?.isConnected ? lastPointerTarget : a instanceof HTMLElement && a !== document.body ? a : null;
  }
  window.location.hash = next;
}
