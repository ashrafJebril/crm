import type { Tx } from "@/lib/tx";
import type { TicketAttachment, TicketAttachmentCandidate } from "@/lib/types";
import { formatBytes, kindOfMime } from "@/components/media/mediaKinds";
import { TICKET_ATTACHMENTS_MAX } from "./ticketFields";

/**
 * SP-09 attachments panel model, pure. The backend gives each file an API
 * path (`/api/tickets/<id>/attachments/<attId>`) that streams the bytes and
 * needs the bearer token, so the UI always fetches it (thumbnail and
 * download) and never renders it as a plain link.
 */

/**
 * The fetchable URL for an attachment `url` against the API base
 * (`VITE_API_URL`, which already ends in `/api`). Anything that is not one of
 * our API paths gives null, so the token is never sent to another host.
 */
export function attachmentFetchUrl(url: string, apiBase: string): string | null {
  const base = apiBase.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(url)) return url.startsWith(`${base}/`) ? url : null;
  if (!url.startsWith("/")) return null;
  const path = url.startsWith("/api/") ? url.slice(4) : url;
  return `${base}${path}`;
}

export interface AttachmentRow {
  id: string;
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: string;
  isImage: boolean;
  source: "customer" | "staff";
  sourceLabel: string;
  addedBy: string | null;
  createdAt: string;
  url: string;
}

export function sourceLabel(tx: Tx, source: string): string {
  return source === "customer" ? tx("Customer", "العميل") : tx("Team", "الفريق");
}

/** List rows, newest first (the server's order, re-applied so an inserted item lands on top). */
export function attachmentRows(items: TicketAttachment[], tx: Tx): AttachmentRow[] {
  return [...items]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1))
    .map((a) => ({
      id: a.id,
      mediaId: a.mediaId,
      fileName: a.fileName || tx("Untitled file", "ملف بلا اسم"),
      mimeType: a.mimeType,
      size: formatBytes(a.sizeBytes),
      isImage: kindOfMime(a.mimeType) === "image",
      source: a.source === "customer" ? "customer" : "staff",
      sourceLabel: sourceLabel(tx, a.source),
      addedBy: a.addedBy?.name ?? null,
      createdAt: a.createdAt,
      url: a.url,
    }));
}

/** Conversation files not yet on the ticket (the server already filters; this covers a stale list after an attach). */
export function pendingCandidates(
  candidates: TicketAttachmentCandidate[],
  attachments: Pick<TicketAttachment, "mediaId">[],
): TicketAttachmentCandidate[] {
  const linked = new Set(attachments.map((a) => a.mediaId));
  return candidates.filter((c) => !linked.has(c.mediaId));
}

/** Room left under the per-ticket cap. */
export function attachmentCapacity(count: number, max = TICKET_ATTACHMENTS_MAX): { full: boolean; left: number } {
  const left = Math.max(0, max - count);
  return { full: left === 0, left };
}

/** Cache update after an attach or upload: the new item on top, no duplicate. */
export function withAttachment(list: TicketAttachment[], item: TicketAttachment): TicketAttachment[] {
  return [item, ...list.filter((a) => a.id !== item.id && a.mediaId !== item.mediaId)];
}

/** Cache update after an unlink. */
export function withoutAttachment(list: TicketAttachment[], id: string): TicketAttachment[] {
  return list.filter((a) => a.id !== id);
}
