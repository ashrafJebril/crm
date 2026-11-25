/**
 * SP-18 client-side attachment checks, mirroring the backend (the server
 * checks again, by the file's first bytes): type by extension, documents up
 * to 20 MB, images up to 5 MB, at most 5 per message.
 */
import { ATTACH_DOC_MAX_BYTES, ATTACH_IMAGE_MAX_BYTES, ATTACH_MAX_PER_MESSAGE } from "./copilotConstants";

const EXT: Record<string, "document" | "image"> = { pdf: "document", csv: "document", xlsx: "document", txt: "document", jpg: "image", jpeg: "image", png: "image", webp: "image" };
export const ATTACH_ACCEPT = ".pdf,.csv,.xlsx,.txt,.jpg,.jpeg,.png,.webp";

export type AttachCheck = { ok: true; kind: "document" | "image" } | { ok: false; key: "copilot.attachment_type" | "copilot.attachment_too_large" | "copilot.too_many_attachments"; extra: Record<string, number> };

export function checkAttachment(file: { name: string; size: number }, alreadyAttached: number): AttachCheck {
  if (alreadyAttached >= ATTACH_MAX_PER_MESSAGE) return { ok: false, key: "copilot.too_many_attachments", extra: { max: ATTACH_MAX_PER_MESSAGE } };
  const ext = /\.([^.\\/]+)$/.exec(file.name || "")?.[1]?.toLowerCase() ?? "";
  const kind = EXT[ext];
  if (!kind || file.size <= 0) return { ok: false, key: "copilot.attachment_type", extra: {} };
  const maxBytes = kind === "image" ? ATTACH_IMAGE_MAX_BYTES : ATTACH_DOC_MAX_BYTES;
  if (file.size > maxBytes) return { ok: false, key: "copilot.attachment_too_large", extra: { maxBytes } };
  return { ok: true, kind };
}
