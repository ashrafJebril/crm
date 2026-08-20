import { API_BASE, tokenStore } from "./client";
import type { Media } from "@/lib/types";

/**
 * Upload one file to the media library and return the created row.
 *
 * Multipart, so it can't go through the JSON `api` client. Throws an Error
 * carrying the server's message when the server rejects the file (unsupported
 * type, too large) so callers can render it verbatim.
 */
export async function uploadMedia(file: File): Promise<Media> {
  const fd = new FormData();
  fd.append("file", file);
  const token = tokenStore.get();
  const resp = await fetch(`${API_BASE}/media/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!resp.ok) {
    let msg = `Upload failed (${resp.status})`;
    try {
      const j = (await resp.json()) as { message?: string };
      if (j.message) msg = j.message;
    } catch {
      /* keep the generic message */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as Media;
}
