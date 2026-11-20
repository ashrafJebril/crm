/**
 * SP-30 (D5, ruling 1): the UI language in the hash query, `#/inbox?lang=ar`.
 * Honoured on load and on hashchange, written into the stored tweaks
 * language, and kept when navigating, so a copied link opens in its language.
 * Pure; the hash is the `location.hash` string (with or without `#`).
 */
export type UiLang = "ar" | "en";

const isLang = (v: unknown): v is UiLang => v === "ar" || v === "en";

function split(hash: string): { path: string; params: URLSearchParams } {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const i = h.indexOf("?");
  return i < 0 ? { path: h, params: new URLSearchParams() } : { path: h.slice(0, i), params: new URLSearchParams(h.slice(i + 1)) };
}

function join(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

/** `ar`/`en` from the hash query, or null (absent or unknown). */
export function readLangParam(hash: string | null | undefined): UiLang | null {
  const v = split(hash ?? "").params.get("lang");
  return isLang(v) ? v : null;
}

/** The hash with `lang` set (other params kept, in order). */
export function withLang(hash: string, lang: UiLang): string {
  const { path, params } = split(hash);
  params.set("lang", lang);
  return join(path, params);
}

/** The hash without an unknown `lang` value (a valid one is kept). */
export function stripUnknownLang(hash: string): string {
  const { path, params } = split(hash);
  const v = params.get("lang");
  if (v === null || isLang(v)) return hash.startsWith("#") || hash === "" ? hash : `#${hash}`;
  params.delete("lang");
  return join(path, params);
}

/**
 * The hash `setRoute(r)` writes: the bare route (its own query is dropped, as
 * before) with the current `lang` kept. Re-selecting the current route keeps
 * the whole hash (e.g. the inbox filter).
 */
export function routeHash(route: string, currentHash: string): string {
  const { path } = split(currentHash);
  if (path.replace(/^\/+/, "") === route) return currentHash.startsWith("#") ? currentHash : `#${currentHash}`;
  const lang = readLangParam(currentHash);
  return lang ? `#/${route}?lang=${lang}` : `#/${route}`;
}

/**
 * Ruling 4: the first-run language. With nothing chosen on this device the
 * active workspace's `lang` applies; a stored choice always wins. Returns the
 * language to apply, or null to keep the current one.
 */
export function firstRunLang(
  stored: { lang?: unknown; langChosen?: unknown } | null | undefined,
  workspaceLang: unknown,
): UiLang | null {
  if (stored && isLang(stored.lang)) {
    // A legacy record (before langChosen existed) counts as chosen.
    if (stored.langChosen === undefined || stored.langChosen === true) return null;
  }
  return isLang(workspaceLang) ? workspaceLang : null;
}
