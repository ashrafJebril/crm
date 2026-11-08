import { normalizeDigits } from "../contacts/contact-name";

const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

const TIMEZONE_COUNTRY_CODES: Record<string, string> = {
  "Asia/Dubai": "971",
  "Asia/Riyadh": "966",
  "Asia/Amman": "962",
  "Asia/Kuwait": "965",
  "Asia/Qatar": "974",
  "Asia/Bahrain": "973",
  "Asia/Muscat": "968",
  "Africa/Cairo": "20",
};

/** Default dialling code for a workspace timezone, or null when unknown. */
export function countryCodeForTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  return TIMEZONE_COUNTRY_CODES[tz] ?? null;
}

/**
 * Import-time phone normalization to E.164 ("+CC…", same shape as the
 * campaign audience's normalizePhone). Unlike that helper, a local number
 * with a leading 0 is completed with `defaultCountryCode` (digits, no "+").
 * Returns null when the number cannot be resolved.
 */
export function normalizeImportPhone(
  raw: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  if (!raw) return null;
  let s = normalizeDigits(String(raw)).replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) {
    if (!defaultCountryCode || !/^\d+$/.test(defaultCountryCode)) return null;
    s = defaultCountryCode + s.replace(/^0+/, "");
  } else return null;
  if (!/^\d+$/.test(s)) return null;
  if (s.length < MIN_DIGITS || s.length > MAX_DIGITS) return null;
  return `+${s}`;
}
