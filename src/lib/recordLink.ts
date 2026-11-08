import { isRecordKind, withRecord } from "./recordParam";

/** Opaque Facebook/Instagram live-thread ids are not DB records. */
export const isOpaqueThreadId = (id: string) => id.startsWith("t_") || id.startsWith("ig:");

/** Where a record lives: the universal record sheet on the current route
 *  (`withRecord(currentHash, …)`), or the inbox deep link for opaque thread ids. */
export function recordHref(
  kind: string | null | undefined,
  id: string | null | undefined,
  currentHash: string = typeof window === "undefined" ? "" : window.location.hash,
): string | null {
  if (!kind || !id || !isRecordKind(kind)) return null;
  if (kind === "conversation" && isOpaqueThreadId(id)) return `#/inbox?open=${encodeURIComponent(id)}`;
  return withRecord(currentHash, { kind, id });
}
