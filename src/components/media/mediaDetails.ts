import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";
import { HEADER_LIMITS } from "./mediaKinds";

/**
 * SP-17 media details (title, alt text, tags, "use when") and the agent
 * approval rules. Pure; mirrors backend `media/media-details.ts`.
 */

export const MEDIA_DETAIL_LIMITS = { title: 120, alt: 500, useWhen: 500, tag: 40, tags: 20 } as const;

/** The only types the agent may send (WhatsApp images), up to 5 MB like template headers. */
export const AGENT_PHOTO_MIMES: readonly string[] = ["image/jpeg", "image/png"];
export const AGENT_PHOTO_MAX_BYTES = HEADER_LIMITS.image;

export type ApprovalBlock = "type" | "size" | "inbound";

/** Body of PATCH /media/:id. Only changed fields are sent. */
export interface UpdateMediaBody {
  title?: string | null;
  alt?: string | null;
  tags?: string[];
  useWhen?: string | null;
  approvedForAgent?: boolean;
}

/** The dialog's editable state (text as typed; tags as one comma-separated line). */
export interface MediaDetailsDraft {
  title: string;
  alt: string;
  tagsText: string;
  useWhen: string;
  approvedForAgent: boolean;
}

/** One tag as the backend stores it: trimmed, Latin letters lowercased, ≤ 40 chars. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase("en").slice(0, MEDIA_DETAIL_LIMITS.tag).trim();
}

/**
 * Tags typed as one line, split on `,` and the Arabic comma `،`, normalised
 * and deduplicated (first kept). Keeps the first 20; `overflow` tells the
 * dialog to say the rest were dropped.
 */
export function parseTagsWithOverflow(text: string): { tags: string[]; overflow: boolean } {
  const all: string[] = [];
  for (const raw of (text ?? "").split(/[,،]/)) {
    const t = normalizeTag(raw);
    if (t && !all.includes(t)) all.push(t);
  }
  return { tags: all.slice(0, MEDIA_DETAIL_LIMITS.tags), overflow: all.length > MEDIA_DETAIL_LIMITS.tags };
}

export const parseTags = (text: string): string[] => parseTagsWithOverflow(text).tags;

/** The draft for a row: null text as "", tags joined with ", ". */
export function detailsDraft(m: Pick<Media, "title" | "alt" | "tags" | "useWhen" | "approvedForAgent">): MediaDetailsDraft {
  return {
    title: m.title ?? "",
    alt: m.alt ?? "",
    tagsText: (m.tags ?? []).join(", "),
    useWhen: m.useWhen ?? "",
    approvedForAgent: m.approvedForAgent === true,
  };
}

const clean = (v: string): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** Only the fields that changed; an emptied field is null; null when nothing changed. */
export function detailsPatch(
  original: Pick<Media, "title" | "alt" | "tags" | "useWhen" | "approvedForAgent">,
  draft: MediaDetailsDraft,
): UpdateMediaBody | null {
  const out: UpdateMediaBody = {};
  for (const k of ["title", "alt", "useWhen"] as const) {
    const next = clean(draft[k]);
    if (next !== (original[k] ?? null)) out[k] = next;
  }
  const tags = parseTags(draft.tagsText);
  const before = original.tags ?? [];
  if (tags.length !== before.length || tags.some((t, i) => t !== before[i])) out.tags = tags;
  if (draft.approvedForAgent !== (original.approvedForAgent === true)) out.approvedForAgent = draft.approvedForAgent;
  return Object.keys(out).length ? out : null;
}

/** Why a file can't be approved for the agent (backend `approvalBlock`), or null. */
export function approvalBlock(m: Pick<Media, "mimeType" | "sizeBytes" | "uploadedById">): ApprovalBlock | null {
  if (!AGENT_PHOTO_MIMES.includes(String(m.mimeType ?? "").toLowerCase())) return "type";
  if (m.sizeBytes > AGENT_PHOTO_MAX_BYTES) return "size";
  if (m.uploadedById == null) return "inbound";
  return null;
}

export function approvalBlockText(reason: ApprovalBlock, tx: Tx): string {
  switch (reason) {
    case "type":
      return tx("Only JPG or PNG photos", "صور JPG أو PNG فقط");
    case "size":
      return tx("Larger than 5 MB", "أكبر من 5 ميغابايت");
    case "inbound":
      return tx("Customer attachments can't be approved", "لا يمكن اعتماد مرفقات العملاء");
  }
}

/** The file name without its extension, as a starting title (≤ 120 chars). */
export function defaultTitle(fileName: string): string {
  const name = (fileName ?? "").trim();
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.slice(0, MEDIA_DETAIL_LIMITS.title).trim();
}

/** What a tile shows: the title, or the file name when undescribed. */
export const displayTitle = (m: Pick<Media, "title" | "fileName">): string => m.title?.trim() || m.fileName;

/**
 * The approval switch's state, the backend rule in one place (dialog and
 * Photos tab):
 * - a blocked file (type, size, inbound) can be switched off but never on;
 * - without `canEdit` (knowledge.update) the switch is disabled;
 * - `needsTitle`: the result is approved with no title, and the change
 *   approves it or changes the title (backend media.title_required). An
 *   untitled row approved earlier can still have other fields edited.
 */
export function approvalSwitchState(
  media: Pick<Media, "mimeType" | "sizeBytes" | "uploadedById" | "approvedForAgent" | "title">,
  draft: { title: string; approvedForAgent: boolean },
  canEdit: boolean,
): { disabled: boolean; needsTitle: boolean; block: ApprovalBlock | null } {
  const block = approvalBlock(media);
  const disabled = !canEdit || (block !== null && !draft.approvedForAgent);
  const title = clean(draft.title);
  const approving = draft.approvedForAgent && media.approvedForAgent !== true;
  const titleChanged = title !== (media.title ?? null);
  const needsTitle = draft.approvedForAgent && title === null && (approving || titleChanged);
  return { disabled, needsTitle, block };
}
