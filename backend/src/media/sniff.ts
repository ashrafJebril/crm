/**
 * SP-13 (ruling 7): file-signature sniffing for the media library. Pure.
 *
 * The client's declared mime type is never trusted on its own: the first
 * bytes of the file must belong to the same family. Families, not exact
 * types: MP4 and QuickTime share the ISO-BMFF `ftyp` box.
 */

export type MediaFamily = "jpeg" | "png" | "gif" | "webp" | "mp4" | "pdf";

/** How many leading bytes sniffing needs. */
export const SNIFF_BYTES = 16;

const FAMILY_BY_MIME: Record<string, MediaFamily> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mp4",
  "application/pdf": "pdf",
};

/** Canonical mime type of each family (used to correct inbound attachments). */
export const MIME_OF_FAMILY: Record<MediaFamily, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

/**
 * ISO-BMFF top-level boxes a MP4/MOV file may open with. `ftyp` is the norm;
 * older QuickTime files start straight with `moov`, `mdat`, `wide` or `free`.
 */
const BMFF_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free"]);

const startsWith = (head: Buffer, sig: number[], at = 0) =>
  head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);
const ascii = (head: Buffer, from: number, to: number) =>
  head.length >= to ? head.subarray(from, to).toString("latin1") : "";

export function sniffFamily(head: Buffer): MediaFamily | null {
  if (!head || head.length < 4) return null;
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  const six = ascii(head, 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return "gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "webp";
  if (ascii(head, 0, 5) === "%PDF-") return "pdf";
  if (BMFF_BOXES.has(ascii(head, 4, 8))) return "mp4";
  return null;
}

/** The family a declared mime type must sniff as; null outside the library. */
export function familyOfMime(mime: string): MediaFamily | null {
  return FAMILY_BY_MIME[String(mime ?? "").toLowerCase()] ?? null;
}
