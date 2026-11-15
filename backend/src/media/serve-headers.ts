import { Logger, NotFoundException } from "@nestjs/common";
import type { Response } from "express";

/** Types served inline. Everything else is a sandboxed download (SP-13). */
const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

/**
 * RFC 5987 `ext-value` encoding: encodeURIComponent leaves `'`, `(`, `)` and
 * `*` alone, but they are not `attr-char`s, so strict parsers would drop the
 * whole `filename*` (and fall back to the ASCII name).
 */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Serving headers for a media response. `nosniff` always; anything that is
 * not a library image or video (PDFs, legacy CSV/XLSX, unknown types) is sent
 * as an attachment with a `sandbox` CSP, so a crafted file can never run as a
 * page on our origin.
 */
export function applyServeHeaders(
  res: Pick<Response, "setHeader">,
  mimeType: string,
  fileName?: string | null,
) {
  res.setHeader("Content-Type", mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (INLINE_TYPES.has(String(mimeType).toLowerCase())) return;
  const name = (fileName ?? "").trim() || "download";
  // ASCII fallback: printable ASCII only, no quote or backslash.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`);
  res.setHeader("Content-Security-Policy", "sandbox");
}

/** What `MediaService.resolveServe` / `resolveServeForRow` hand back. */
export type ResolvedServe =
  | { kind: "local-file"; absolutePath: string; mimeType: string; fileName?: string }
  | { kind: "signed-url"; url: string; mimeType: string; fileName?: string };

const log = new Logger("MediaServe");

/**
 * Send a resolved file as the response body (SP-09 extraction of the
 * `GET /media/:id/file` code, shared with the ticket attachment download):
 * a local file through `sendFile`; a Spaces object proxied as a stream, never
 * a 302. The frontend's fetch sends an Authorization header, which triggers a
 * CORS preflight on a redirect target that DO Spaces' allowlist rejects, and a
 * signed URL must never reach the client. `label` is what a failure log names
 * (an id, never a storage path or a URL).
 */
export async function sendResolved(
  res: Response,
  resolved: ResolvedServe,
  opts: { cacheControl: string; label: string },
): Promise<void> {
  if (resolved.kind === "signed-url") {
    // Videos are capped at 300 MB, so the response is piped through rather
    // than buffered in memory. Cost: one extra hop.
    const upstream = await fetch(resolved.url);
    if (!upstream.ok) {
      throw new NotFoundException(`Upstream fetch failed (${upstream.status})`);
    }
    applyServeHeaders(res, resolved.mimeType, resolved.fileName);
    res.setHeader("Cache-Control", opts.cacheControl);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    const { Readable } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    try {
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } catch (e) {
      // Upstream (DO Spaces) can die mid-transfer on a large video — a plain
      // .pipe() leaves that as an unhandled stream error that kills the whole
      // process. pipeline() surfaces it here instead; headers are already
      // sent, so just destroy the response (client sees a truncated/failed
      // download) rather than trying to respond again.
      log.warn(`Media stream from Spaces failed for ${opts.label}: ${(e as Error).message}`);
      res.destroy();
    }
    return;
  }
  applyServeHeaders(res, resolved.mimeType, resolved.fileName);
  res.setHeader("Cache-Control", opts.cacheControl);
  res.sendFile(resolved.absolutePath);
}
