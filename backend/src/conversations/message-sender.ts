import type { Viewer } from "../permissions/visibility";

/**
 * SP-11 `Message.sentById` for a staff message sent from the inbox: the
 * requesting member's user id. Super-admin and impersonation sessions act
 * without a member row, so their sends stay unattributed (null), as do AI
 * replies, workflow and campaign sends and every internal caller (no viewer).
 */
export function staffSenderId(viewer?: Viewer | null): string | undefined {
  if (!viewer || viewer.bypass || !viewer.userId) return undefined;
  return viewer.userId;
}

/** The `sentById` part of a Message create: empty when there is no sender,
 *  so existing writes are byte-for-byte unchanged. */
export function sentByData(actorId?: string | null): { sentById?: string } {
  return actorId ? { sentById: actorId } : {};
}
