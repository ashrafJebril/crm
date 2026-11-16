/**
 * SP-10: one normal form for catalog names in English and Arabic, used by
 * the catalog search (`q`) and by catalog-import duplicate detection.
 * Trim, collapse whitespace, Latin lowercase; Arabic: strip tatweel and
 * diacritics, unify أ/إ/آ → ا, ى → ي, ة → ه. Pure.
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

/** True when `q` (normalized) occurs in any of the names (normalized). */
export function nameMatches(q: string, ...names: (string | null | undefined)[]): boolean {
  const needle = normalizeName(q);
  if (!needle) return true;
  return names.some((n) => normalizeName(n).includes(needle));
}
