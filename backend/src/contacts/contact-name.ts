/** Split on the first whitespace run after trim. */
export function splitName(name: string): { firstName: string; lastName: string | null } {
  const t = (name ?? "").trim();
  const m = t.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { firstName: t, lastName: null };
  return { firstName: m[1], lastName: m[2].trim() || null };
}

export function joinName(first?: string | null, last?: string | null): string {
  return [first, last]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
