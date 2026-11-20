/**
 * SP-29 branding (pure). Mirrors backend/src/workspaces/brand-constants.ts
 * (brand.test.ts pins the values). The logo is checked here before upload
 * with the same keys the server answers with; the server checks again,
 * including the file's first bytes.
 */
import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import { mediaErrorText } from "@/components/media/mediaErrors";

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_ACCEPT = LOGO_TYPES.join(",");
export const DEFAULT_CHAT_COLOR = "#111827";
export const SAVED_FLASH_MS = 2000;

const EXT_TYPE: Record<string, (typeof LOGO_TYPES)[number]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export type LogoCheck =
  | { key: "media.unsupported_type"; extra: { allowed: string[] } }
  | { key: "media.too_large"; extra: { limit: number } }
  | { key: "media.no_file"; extra: Record<string, never> };

/** Null when the file may be uploaded; else the server's key for the refusal. */
export function validateLogoFile(file: { name: string; type: string; size: number } | null | undefined): LogoCheck | null {
  if (!file || file.size <= 0) return { key: "media.no_file", extra: {} };
  const ext = /\.([^.\\/]+)$/.exec(file.name || "")?.[1]?.toLowerCase() ?? "";
  const type = (file.type || "").toLowerCase();
  // The declared type decides (SVG, GIF and anything else are refused); an extension must agree with it.
  const typeOk = (LOGO_TYPES as readonly string[]).includes(type);
  const extOk = !ext || EXT_TYPE[ext] === type;
  if (!typeOk || !extOk) return { key: "media.unsupported_type", extra: { allowed: [...LOGO_TYPES] } };
  if (file.size > LOGO_MAX_BYTES) return { key: "media.too_large", extra: { limit: LOGO_MAX_BYTES } };
  return null;
}

export const BRAND_COLOR_COPY = (tx: Tx) =>
  tx("Enter a colour as # and 3 or 6 hex digits, for example #c9a55a.", "أدخل اللون بصيغة # ثم 3 أو 6 خانات سداسية، مثل #c9a55a.");

/** Copy for a logo check or a branding API error (the SP-13 media copy, and the colour key). */
export function brandErrorText(err: unknown, tx: Tx): string {
  const body = err instanceof ApiError ? (err.body as { message?: unknown } | undefined) : undefined;
  const key = typeof body?.message === "string" ? body.message : err instanceof Error ? err.message : "";
  if (key === "workspaces.invalid_brand_color") return BRAND_COLOR_COPY(tx);
  return mediaErrorText(err, tx);
}

/** The client check as an ApiError, so the same copy path words it. */
export function logoCheckError(c: LogoCheck): ApiError {
  return new ApiError(c.key, 400, undefined, { statusCode: 400, message: c.key, ...c.extra });
}
