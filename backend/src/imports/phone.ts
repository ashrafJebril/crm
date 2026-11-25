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
  const input = normalizeDigits(String(raw));
  if (/\p{L}/u.test(input)) return null; // "ext 12", words, etc.
  let s = input.replace(/[^\d+]/g, "");
  if (!s) return null;
  const cc = defaultCountryCode && /^\d+$/.test(defaultCountryCode) ? defaultCountryCode : null;
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) {
    if (!cc) return null;
    s = cc + s.replace(/^0+/, "");
  } else {
    // Bare digits (e.g. a numeric spreadsheet cell): only when they already
    // start with the default country code and are long enough to be full.
    if (!cc || !s.startsWith(cc) || s.length < 11 || s.length > MAX_DIGITS) return null;
  }
  if (!/^\d+$/.test(s)) return null;
  if (s.startsWith("0")) return null; // no country code starts with 0
  // Trunk zero kept after the country code (+971 0501234567): drop it.
  if (cc && s.startsWith(cc + "0")) s = cc + s.slice(cc.length + 1);
  if (s.length < MIN_DIGITS || s.length > MAX_DIGITS) return null;
  return `+${s}`;
}
