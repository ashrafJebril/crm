import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { formatBytes } from "./mediaKinds";

/**
 * Localized copy for the media library and template-header error keys
 * (backend media/media-errors.ts and integrations/template-header.ts). The
 * backend puts the key in `message` and extras (`limit`, `allowed`, `templates`,
 * `campaigns`) next to it, which `ApiError` exposes as `.message` and `.body`.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

const SHORT_TYPE: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "application/pdf": "PDF",
};

const typeList = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  const names = [...new Set(v.map((x) => (typeof x === "string" ? (SHORT_TYPE[x] ?? x) : "")).filter(Boolean))];
  return names.length ? names.join(", ") : null;
};

const bytes = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? formatBytes(n) : null;
};

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (isObject(x) && typeof x.name === "string" ? x.name.trim() : ""))
        .filter(Boolean)
    : [];

/** "a", "a and b", "a, b and 2 more" (en) / Arabic equivalents. */
function nameList(list: string[], tx: Tx): string {
  const quoted = list.map((n) => `“${n}”`);
  if (quoted.length <= 2) return quoted.join(tx(" and ", " و"));
  const more = quoted.length - 2;
  return tx(`${quoted.slice(0, 2).join(", ")} and ${more} more`, `${quoted.slice(0, 2).join("، ")} و${more} غيرها`);
}

/**
 * SP-13 final review: GET /media needs conversations.view. Without it (or
 * when the server refuses with 403) the Gallery and the header picker show a
 * plain no-access line instead of an error and do not fetch.
 */
export function mediaLibraryBlocked(canView: boolean, error: unknown): boolean {
  return !canView || (error instanceof ApiError && error.status === 403);
}

export function mediaNoAccessText(tx: Tx): string {
  return tx(
    "Your role can't open the media library. Ask an admin for access to conversations.",
    "لا يسمح دورك بفتح مكتبة الوسائط. اطلب من المسؤول صلاحية الوصول إلى المحادثات.",
  );
}

export const MEDIA_ERROR_COPY: Record<string, CopyFn> = {
  "media.no_file": () => ["Choose a file to upload.", "اختر ملفًا لرفعه."],
  "media.unsupported_type": (x) => {
    const allowed = typeList(x.allowed);
    return allowed
      ? [`That file type isn't supported. Use ${allowed}.`, `نوع هذا الملف غير مدعوم. استخدم ${allowed}.`]
      : ["That file type isn't supported.", "نوع هذا الملف غير مدعوم."];
  },
  "media.too_large": (x) => {
    const limit = bytes(x.limit);
    return limit
      ? [`That file is too large. The limit for this type is ${limit}.`, `هذا الملف كبير جدًا. الحد لهذا النوع ${limit}.`]
      : ["That file is too large.", "هذا الملف كبير جدًا."];
  },
  "media.type_mismatch": () => [
    "The file's contents don't match its type. It may be renamed or damaged.",
    "محتوى الملف لا يطابق نوعه. ربما أُعيدت تسميته أو أنه تالف.",
  ],
  "media.invalid_query": () => ["The file list couldn't be loaded. Refresh and try again.", "تعذّر تحميل قائمة الملفات. حدّث الصفحة وحاول مجددًا."],
  // `media.in_use` needs the names, so its copy is built in mediaErrorText; this is the plain fallback.
  "media.in_use": () => [
    "This file is used by a template or a campaign, so it can't be deleted.",
    "هذا الملف مستخدم في قالب أو حملة، لذا لا يمكن حذفه.",
  ],
  "Media not found": () => ["That file no longer exists.", "هذا الملف لم يعد موجودًا."],
  "templates.header_media_too_large": (x) => {
    const limit = bytes(x.limit);
    return limit
      ? [`That file is larger than WhatsApp's ${limit} header limit.`, `هذا الملف أكبر من حد ترويسة واتساب ${limit}.`]
      : ["That file is larger than WhatsApp's header limit.", "هذا الملف أكبر من حد ترويسة واتساب."];
  },
  "templates.header_media_mismatch": () => [
    "The header file does not match the template's header type. Pick a matching file.",
    "ملف الترويسة لا يطابق نوع ترويسة القالب. اختر ملفًا مطابقًا.",
  ],
  "templates.header_media_required": () => [
    "Choose a file for the template header.",
    "اختر ملفًا لترويسة القالب.",
  ],
};

/** Copy for a key with its extras, or null when the key is not a media key. */
export function mediaKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const x = isObject(extra) ? extra : {};
  if (key === "media.in_use") {
    const tpl = names(x.templates);
    const cmp = names(x.campaigns);
    if (tpl.length || cmp.length) {
      const parts: string[] = [];
      if (tpl.length) parts.push(tx(`template ${nameList(tpl, tx)}`, `القالب ${nameList(tpl, tx)}`));
      if (cmp.length) parts.push(tx(`campaign ${nameList(cmp, tx)}`, `الحملة ${nameList(cmp, tx)}`));
      const used = parts.join(tx(" and ", " و"));
      return tx(
        `This file is used by ${used}, so it can't be deleted. Change those first.`,
        `هذا الملف مستخدم في ${used}، لذا لا يمكن حذفه. غيّرها أولًا.`,
      );
    }
  }
  const copy = MEDIA_ERROR_COPY[key];
  if (!copy) return null;
  const [en, ar] = copy(x);
  return tx(en, ar);
}

/** User-facing text for a media upload, list or delete error. */
export function mediaErrorText(err: unknown, tx: Tx, fallback?: string): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : "";
  const key = message.split(", ")[0] ?? "";
  const body = err instanceof ApiError ? err.body : undefined;
  return (
    mediaKeyText(key, body, tx) ??
    fallback ??
    tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.")
  );
}
