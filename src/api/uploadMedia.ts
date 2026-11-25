import { API_BASE, ApiError, tokenStore } from "./client";
import type { Media } from "@/lib/types";

/**
 * Upload one file to the media library and return the created row.
 *
 * Multipart, so it can't go through the JSON `api` client. Throws an
 * `ApiError` carrying the server's key (`media.unsupported_type`,
 * `media.too_large`, `media.type_mismatch`, …) and its body (`limit`,
 * `allowed`), so callers word it with `mediaErrorText`.
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
    let body: unknown;
    try {
      body = await resp.json();
      const m = (body as { message?: unknown }).message;
      if (typeof m === "string" && m) msg = m;
      else if (Array.isArray(m)) msg = m.join(", ");
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(msg, resp.status, undefined, body);
  }
  return (await resp.json()) as Media;
}
