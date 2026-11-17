import type { RouteId } from "@/lib/types";

/**
 * SP-26 public account pages, chosen before the auth gate:
 *  - `/invite?token=…` (emailed link) or `#/accept-invite?token=…`
 *  - `/reset?token=…` (emailed link) or `#/reset-password?token=…`
 *  - `#/forgot-password`
 *  - `#/activate?ws=<slug>&next=<route>`
 * Tokens never leave this module except to the API; the caller strips them
 * from the address bar with `replaceState` right after reading.
 */
export type PublicPage =
  | { kind: "accept"; token: string }
  | { kind: "reset"; token: string }
  | { kind: "forgot" }
  | { kind: "activate"; slug: string; next: RouteId };

const KNOWN_ROUTES: readonly RouteId[] = [
  "dashboard", "inbox", "calendar", "social", "campaigns", "pipeline", "workflows", "contacts",
  "followups", "analytics", "templates", "media", "team", "agent", "settings", "channels", "ads", "admin", "setup",
];

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Only a known app route; anything else (URLs, `//host`, encoded tricks) → dashboard. */
export function safeNext(next: string | null | undefined): RouteId {
  if (!next) return "dashboard";
  let v = next;
  try {
    v = decodeURIComponent(next);
  } catch {
    return "dashboard";
  }
  v = v.replace(/^#?\/?/, "");
  return (KNOWN_ROUTES as readonly string[]).includes(v) ? (v as RouteId) : "dashboard";
}

function token(params: URLSearchParams): string | null {
  const t = params.get("token");
  return t && TOKEN_RE.test(t) ? t : null;
}

/** Parses a `#/…` fragment. A missing or malformed token → null. */
export function parsePublicFragment(hash: string): PublicPage | null {
  const m = /^#\/?([a-z-]+)(?:\?(.*))?$/.exec(hash ?? "");
  if (!m) return null;
  const params = new URLSearchParams(m[2] ?? "");
  switch (m[1]) {
    case "accept-invite": {
      const t = token(params);
      return t ? { kind: "accept", token: t } : null;
    }
    case "reset-password": {
      const t = token(params);
      return t ? { kind: "reset", token: t } : null;
    }
    case "forgot-password":
      return { kind: "forgot" };
    case "activate": {
      const slug = params.get("ws");
      return slug && SLUG_RE.test(slug) ? { kind: "activate", slug, next: safeNext(params.get("next")) } : null;
    }
    default:
      return null;
  }
}

/** The emailed path links (`/invite?token=`, `/reset?token=`), then the fragment. */
export function parsePublicLocation(loc: { pathname: string; search: string; hash: string }): PublicPage | null {
  const path = loc.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams(loc.search);
  if (path === "/invite") {
    const t = token(params);
    return t ? { kind: "accept", token: t } : null;
  }
  if (path === "/reset") {
    const t = token(params);
    return t ? { kind: "reset", token: t } : null;
  }
  return parsePublicFragment(loc.hash);
}

/** Where the page lives once the token is read: the token never stays in
 *  the address bar or history. */
export function scrubbedUrl(page: PublicPage, lang: string | null): string {
  const q = lang === "ar" || lang === "en" ? `?lang=${lang}` : "";
  switch (page.kind) {
    case "accept":
      return `/${q}#/accept-invite`;
    case "reset":
      return `/${q}#/reset-password`;
    case "forgot":
      return `/${q}#/forgot-password`;
    case "activate":
      return `/${q}#/activate?ws=${encodeURIComponent(page.slug)}&next=${page.next}`;
  }
}

/** `?lang=` from the link, else null (the stored language applies). */
export function langParam(search: string): "ar" | "en" | null {
  const v = new URLSearchParams(search).get("lang");
  return v === "ar" || v === "en" ? v : null;
}

/** Ruling 11: the old "remember me" kept the password in plaintext. Removes
 *  it from this browser once, on boot. Returns true when one was removed. */
export const LEGACY_REMEMBER_PW_KEY = "aram.remember.password";
export function removeRememberedPassword(storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined): boolean {
  if (!storage) return false;
  try {
    const had = storage.getItem(LEGACY_REMEMBER_PW_KEY) !== null;
    storage.removeItem(LEGACY_REMEMBER_PW_KEY);
    return had;
  } catch {
    return false;
  }
}
