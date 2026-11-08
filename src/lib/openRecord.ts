import { isOpaqueThreadId } from "./recordLink";
import { isRecordKind, recordNavTarget, type RecordKind } from "./recordParam";

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
  if (next) window.location.hash = next;
}
