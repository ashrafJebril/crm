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

/** SP-14: notification titles that deep-link to a channel (`body.channelId`) instead of a record. */
const CHANNEL_TITLES = new Set(["channel.health_downgraded"]);

function channelIdOf(body: string | null | undefined): string | null {
  if (!body) return null;
  try {
    const v: unknown = JSON.parse(body);
    const id = v && typeof v === "object" ? (v as { channelId?: unknown }).channelId : undefined;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Where a notification opens: a channel's detail for health alerts, the Ads
 *  connection for a Meta Ads reconnect, else its record (`recordHref`). */
export function notificationHref(
  n: { title: string; body?: string | null; recordKind?: string | null; recordId?: string | null },
  currentHash: string = typeof window === "undefined" ? "" : window.location.hash,
): string | null {
  // SP-15: the Meta Ads reconnect alert opens the Ads connection tab.
  if (n.title === "meta_ads.needs_reconnect") return "#/ads?tab=connection";
  if (CHANNEL_TITLES.has(n.title)) {
    const id = channelIdOf(n.body);
    return id ? `#/channels?id=${encodeURIComponent(id)}` : "#/channels";
  }
  return recordHref(n.recordKind, n.recordId, currentHash);
}
