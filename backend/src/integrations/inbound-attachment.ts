/**
 * The declared type handed to MediaService.ingestBuffer for an inbound Zernio
 * attachment. The bytes are sniffed afterwards, so this only has to be a type
 * the ingest gate accepts: the payload's type or the download's header when
 * either is an image/video type, otherwise a fallback from the attachment's
 * own kind. (Headers like application/octet-stream would otherwise refuse a
 * real video before it is ever sniffed.)
 */
export function inboundAttachmentMime(
  attachmentType: string | undefined,
  payloadMime: string | undefined,
  headerMime: string | undefined,
): string {
  for (const m of [payloadMime, headerMime]) {
    const v = String(m ?? "").toLowerCase().trim();
    if (v.startsWith("image/") || v.startsWith("video/")) return v;
  }
  return attachmentType === "video" ? "video/mp4" : "image/jpeg";
}
