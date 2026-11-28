import { MIME_OF_FAMILY, sniffFamily } from "../media/sniff";

/**
 * What a customer sent us, decided from the file's own bytes (never from the
 * provider's type alone) and stored under that type. Pure.
 *
 * Wider than the library's sniffer on purpose: a chat attachment may be a voice
 * note or a document. The library sniffer stays as it is, because import files
 * (XLSX) rely on it NOT recognising ZIP.
 */
export type InboundMedia = {
  mimeType: string;
  /** Images and videos show in the media library as before; voice notes and files stay out of it. */
  kind: "image" | "video" | "audio" | "file";
};

/** Office files are ZIPs; the provider's declared type says which one. */
const OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const ascii = (b: Buffer, from: number, to: number) => (b.length >= to ? b.subarray(from, to).toString("latin1") : "");

/**
 * @param head the file's first bytes (16 are enough)
 * @param attachmentType the provider's kind: "image" | "video" | "audio" | "file" | "sticker" | …
 * @param declaredMimes the payload's and the download's content types, either may be missing
 * @returns null when the bytes are nothing we store
 */
export function inboundMedia(
  head: Buffer,
  attachmentType: string | undefined,
  ...declaredMimes: Array<string | undefined>
): InboundMedia | null {
  const declared = declaredMimes.map((m) => String(m ?? "").toLowerCase().split(";")[0].trim()).filter(Boolean);
  const saysAudio = attachmentType === "audio" || declared.some((m) => m.startsWith("audio/"));

  const family = sniffFamily(head);
  if (family === "jpeg" || family === "png" || family === "gif" || family === "webp") {
    return { mimeType: MIME_OF_FAMILY[family], kind: "image" };
  }
  // MP4 and M4A share the ISO-BMFF container: the provider says which one.
  if (family === "mp4") return saysAudio ? { mimeType: "audio/mp4", kind: "audio" } : { mimeType: "video/mp4", kind: "video" };
  if (family === "pdf") return { mimeType: "application/pdf", kind: "file" };

  if (head.length < 4) return null;
  if (ascii(head, 0, 4) === "OggS") return { mimeType: "audio/ogg", kind: "audio" }; // WhatsApp voice notes (Opus)
  if (ascii(head, 0, 5) === "#!AMR") return { mimeType: "audio/amr", kind: "audio" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return { mimeType: "audio/wav", kind: "audio" };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return saysAudio ? { mimeType: "audio/webm", kind: "audio" } : { mimeType: "video/webm", kind: "video" };
  }
  if (ascii(head, 0, 3) === "ID3") return { mimeType: "audio/mpeg", kind: "audio" };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // MPEG frame sync: layer bits 00 is an AAC (ADTS) stream, anything else MP3.
    return (head[1] & 0x06) === 0 ? { mimeType: "audio/aac", kind: "audio" } : { mimeType: "audio/mpeg", kind: "audio" };
  }
  if (ascii(head, 0, 4) === "PK\x03\x04") {
    const office = declared.find((m) => OFFICE_MIMES.has(m));
    return office ? { mimeType: office, kind: "file" } : null;
  }
  return null;
}

