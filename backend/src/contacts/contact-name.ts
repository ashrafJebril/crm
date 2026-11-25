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

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII; the Arabic decimal
 * mark (٫) becomes "." and the thousands mark (٬) is dropped — mirrors the
 * frontend's src/screens/contacts/fieldValue.ts.
 */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
}

/**
 * The first/last parts to trust for a stored contact. Integrations (WhatsApp,
 * Meta, HJZ, …) write only `name` and HJZ rewrites `name` without touching the
 * parts, so the stored parts count only when firstName is non-empty and they
 * still join to `name`; otherwise derive them from `name`.
 */
export function effectiveNameParts(stored: {
  name: string;
  firstName: string | null;
  lastName: string | null;
}): { firstName: string | null; lastName: string | null } {
  const first = (stored.firstName ?? "").trim();
  if (first && joinName(stored.firstName, stored.lastName) === (stored.name ?? "").trim()) {
    return { firstName: first, lastName: (stored.lastName ?? "").trim() || null };
  }
  const { firstName, lastName } = splitName(stored.name ?? "");
  return { firstName: firstName || null, lastName };
}

/** Values of the built-in lifecycle set, stored lower-case. */
export const KNOWN_LIFECYCLES = ["lead", "customer", "churned", "patient", "blocked"] as const;

/** Lower-cases a known lifecycle value ("Lead" → "lead"); leaves custom values as-is. */
export function normalizeLifecycle<T extends string | undefined | null>(v: T): T {
  if (typeof v !== "string") return v;
  const lc = v.toLowerCase();
  return ((KNOWN_LIFECYCLES as readonly string[]).includes(lc) ? lc : v) as T;
}
