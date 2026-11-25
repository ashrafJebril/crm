import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";

/**
 * SP-13 media kinds, WhatsApp header rules and Gallery paging. Pure, so the
 * limits and the cursor contract are unit-tested.
 *
 * Header types and sizes mirror backend `integrations/template-header.ts`
 * (`HEADER_LIMITS`): WhatsApp takes JPEG/PNG images up to 5 MB, MP4 videos up
 * to 16 MB and PDF documents up to 100 MB in a template header. The library
 * itself accepts more (webp, gif, quicktime, bigger videos) for social posts.
 */

export type HeaderKind = "text" | "image" | "video" | "document";
export type HeaderMediaKind = Exclude<HeaderKind, "text">;
export type MediaKind = "image" | "video" | "document";

const MB = 1024 * 1024;

export const HEADER_MIMES: Record<HeaderMediaKind, string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  document: ["application/pdf"],
};

/** Bytes; the same values as the backend (5242880, 16 MB, 100 MB). */
export const HEADER_LIMITS: Record<HeaderMediaKind, number> = {
  image: 5 * MB,
  video: 16 * MB,
  document: 100 * MB,
};

/** Library upload types and caps (backend media.service). */
export const LIBRARY_MIMES: Record<MediaKind, string[]> = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
  document: ["application/pdf"],
};

export const LIBRARY_LIMITS: Record<MediaKind, number> = {
  image: 20 * MB,
  video: 300 * MB,
  document: 100 * MB,
};

export function kindOfMime(mime: string | null | undefined): MediaKind | null {
  const m = (mime ?? "").toLowerCase();
  for (const k of ["image", "video", "document"] as const) if (LIBRARY_MIMES[k].includes(m)) return k;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}

/** "text" | "image" | "video" | "document" from a template's headerType (any case); null when none. */
export function headerKind(t: { headerType?: string | null } | null | undefined): HeaderKind | null {
  const v = t?.headerType?.toLowerCase();
  return v === "text" || v === "image" || v === "video" || v === "document" ? v : null;
}

/** The file's type is one WhatsApp accepts for this header kind (type only, as SP-31). */
export const mediaMatchesHeader = (m: Pick<Media, "mimeType">, kind: HeaderKind): boolean =>
  kind !== "text" && HEADER_MIMES[kind].includes(m.mimeType);

/** Type and size within WhatsApp's header limit. */
export const mediaFitsHeader = (m: Pick<Media, "mimeType" | "sizeBytes">, kind: HeaderMediaKind): boolean =>
  mediaMatchesHeader(m, kind) && m.sizeBytes <= HEADER_LIMITS[kind];

/** "5 MB", "16 MB", "1.5 MB", "820 KB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  const v = n / MB;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
}

/**
 * Why a library file can't be this template header, or null when it can.
 * Shown greyed out in the picker with this text as the reason.
 */
export function headerIneligibleReason(
  m: Pick<Media, "mimeType" | "sizeBytes">,
  kind: HeaderMediaKind,
  tx: Tx,
): string | null {
  if (!mediaMatchesHeader(m, kind)) {
    return {
      image: tx("WhatsApp headers take JPG or PNG images only", "ترويسات واتساب تقبل صور JPG أو PNG فقط"),
      video: tx("WhatsApp headers take MP4 videos only", "ترويسات واتساب تقبل فيديو MP4 فقط"),
      document: tx("WhatsApp headers take PDF documents only", "ترويسات واتساب تقبل مستندات PDF فقط"),
    }[kind];
  }
  const limit = HEADER_LIMITS[kind];
  if (m.sizeBytes > limit) {
    const l = formatBytes(limit);
    return tx(`Larger than WhatsApp's ${l} header limit`, `أكبر من حد ترويسة واتساب ${l}`);
  }
  return null;
}

export type MediaCategory = "all" | MediaKind;

export const MEDIA_CATEGORIES: { id: MediaCategory; en: string; ar: string }[] = [
  { id: "all", en: "All", ar: "الكل" },
  { id: "image", en: "Images", ar: "الصور" },
  { id: "video", en: "Videos", ar: "الفيديو" },
  { id: "document", en: "Documents", ar: "المستندات" },
];

// ── paging (GET /media?kind=&before=&limit=) ──────────────────────────────

export const MEDIA_PAGE = 60;
/** Response header naming the next `before`; absent only at the true end of the list. */
export const NEXT_BEFORE_HEADER = "X-Media-Next-Before";

/** SP-17: search text (≤ 100 after trimming) and the agent-approval filter. */
export interface MediaFilters {
  q?: string;
  approved?: boolean;
}

/** Longest `q` the backend accepts. */
export const MEDIA_QUERY_MAX = 100;

export function mediaPagePath(
  kind: MediaCategory,
  before: string | null,
  limit = MEDIA_PAGE,
  filters: MediaFilters = {},
): string {
  const q = new URLSearchParams({ kind, limit: String(limit) });
  if (before) q.set("before", before);
  const text = (filters.q ?? "").trim().slice(0, MEDIA_QUERY_MAX).trim();
  if (text) q.set("q", text);
  if (filters.approved !== undefined) q.set("approved", String(filters.approved));
  return `/media?${q.toString()}`;
}

export interface MediaPage {
  items: Media[];
  /** null = end of list. A short or empty page is NOT the end while this is set. */
  nextBefore: string | null;
}

/** Reads one page from the body and the cursor header (the body stays a plain array). */
export function parseMediaPage(body: unknown, nextBeforeHeader: string | null | undefined): MediaPage {
  const items = Array.isArray(body) ? (body as Media[]) : [];
  const next = typeof nextBeforeHeader === "string" ? nextBeforeHeader.trim() : "";
  return { items, nextBefore: next || null };
}

/** All pages in order, without duplicates (a file can't appear twice). */
export function flattenMediaPages(pages: readonly MediaPage[]): Media[] {
  const seen = new Set<string>();
  const out: Media[] = [];
  for (const p of pages)
    for (const m of p.items) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  return out;
}

/** The cursor for "Load more"; null when the last page had no header. */
export const nextMediaCursor = (pages: readonly MediaPage[]): string | null =>
  pages.length === 0 ? null : (pages[pages.length - 1]!.nextBefore ?? null);
