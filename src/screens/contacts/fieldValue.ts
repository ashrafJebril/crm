import type { CustomFieldType, Lang } from "@/lib/types";

export type FieldValue = string | number | boolean | null;
export type ParseResult =
  | { ok: true; value: FieldValue }
  | { ok: false; error: { en: string; ar: string } };

const MAX_TEXT = 2000;

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII; Arabic decimal/thousands marks too. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
}

const bad = (en: string, ar: string): ParseResult => ({ ok: false, error: { en, ar } });

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Mirrors the server's custom-field rules. Empty input clears the value (null). */
export function parseFieldInput(
  type: CustomFieldType,
  raw: string | boolean,
  options?: string[] | null,
): ParseResult {
  if (type === "boolean") {
    return typeof raw === "boolean"
      ? { ok: true, value: raw }
      : bad("Must be yes or no", "يجب أن تكون نعم أو لا");
  }
  if (typeof raw !== "string") return bad("Invalid value", "قيمة غير صالحة");

  if (type === "text") {
    const v = raw.trim();
    if (v === "") return { ok: true, value: null };
    if (v.length > MAX_TEXT) return bad("Text is too long (max 2000)", "النص طويل جدًا (الحد 2000)");
    return { ok: true, value: v };
  }
  if (type === "number") {
    const v = normalizeDigits(raw.trim());
    if (v === "") return { ok: true, value: null };
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return bad("Enter a valid number", "أدخل رقمًا صالحًا");
    const n = Number(v);
    if (!Number.isFinite(n)) return bad("Enter a valid number", "أدخل رقمًا صالحًا");
    return { ok: true, value: n };
  }
  if (type === "date") {
    const v = normalizeDigits(raw.trim());
    if (v === "") return { ok: true, value: null };
    if (!isRealDate(v)) return bad("Enter a valid date (YYYY-MM-DD)", "أدخل تاريخًا صالحًا (YYYY-MM-DD)");
    return { ok: true, value: v };
  }
  // select
  if (raw === "") return { ok: true, value: null };
  if (!(options ?? []).includes(raw)) return bad("Choose one of the listed options", "اختر أحد الخيارات المتاحة");
  return { ok: true, value: raw };
}

export function formatFieldValue(
  type: CustomFieldType,
  value: FieldValue | undefined,
  lang: Lang,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "boolean") return value ? (lang === "ar" ? "نعم" : "Yes") : lang === "ar" ? "لا" : "No";
  if (type === "number" && typeof value === "number") {
    return value.toLocaleString(lang === "ar" ? "ar" : "en-US");
  }
  return String(value);
}
