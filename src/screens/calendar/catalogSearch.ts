/**
 * SP-10 name normalization for catalog search: mirror of
 * backend/src/bookings/names.ts (trim, collapse spaces, Latin lowercase;
 * Arabic: no tatweel or diacritics, أ/إ/آ/ٱ→ا, ى→ي, ة→ه). Pure.
 */
const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .replace(TATWEEL, "")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the (normalized) search occurs in any of the names; an empty search matches all. */
export function matchesSearch(q: string, ...names: (string | null | undefined)[]): boolean {
  const needle = normalizeName(q);
  if (!needle) return true;
  return names.some((n) => normalizeName(n).includes(needle));
}
