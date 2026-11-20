/**
 * SP-29 (ruling 8): the brand an email carries (pure). The logo is the
 * absolute public URL built from BACKEND_PUBLIC_URL (none without it: an
 * email cannot load a relative URL); the colour is re-validated.
 */
import { brandInk, safeBrandColor } from "./brand-color";
import { logoPath } from "./brand-constants";

export interface EmailBrand {
  name: string;
  /** Absolute public URL of the logo, or null. */
  logoUrl: string | null;
  /** `#rrggbb` or null. */
  color: string | null;
  /** The text colour on `color`. */
  ink: string | null;
}

/**
 * An email logo URL, or null: absolute, with no quote, space or angle
 * bracket, and https: only (a mail client may refuse or warn on http:).
 * http: is accepted only when NODE_ENV is development or test (local mail
 * catchers on a loopback backend).
 */
export function safeEmailLogoUrl(u: unknown, nodeEnv: string | undefined = process.env.NODE_ENV): string | null {
  if (typeof u !== "string") return null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
  const dev = nodeEnv === "development" || nodeEnv === "test";
  return dev && /^http:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
}

export function emailBrandOf(
  ws: { id: string; name: string; logoMediaId?: string | null; brandColor?: string | null },
  base: string | undefined = process.env.BACKEND_PUBLIC_URL,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): EmailBrand {
  const root = String(base ?? "").trim().replace(/\/+$/, "");
  const color = safeBrandColor(ws.brandColor);
  return {
    name: ws.name,
    logoUrl: ws.logoMediaId && root ? safeEmailLogoUrl(`${root}${logoPath(ws.id, ws.logoMediaId)}`, nodeEnv) : null,
    color,
    ink: color ? brandInk(color) : null,
  };
}

/** The layout's `brand` input for a workspace (SP-26 email templates). */
export function layoutBrandOf(ws: { id: string; name: string; logoMediaId?: string | null; brandColor?: string | null } | null | undefined) {
  if (!ws) return undefined;
  const b = emailBrandOf(ws);
  return { name: b.name, ...(b.color ? { color: b.color } : {}), ...(b.logoUrl ? { logoUrl: b.logoUrl } : {}) };
}
