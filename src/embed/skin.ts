// Host skin: in embed mode the parent (Tiremall admin) may pass
// `&skin=<base64url(JSON)>` in the URL fragment so the CRM adopts its look
// before first paint. Everything is allowlisted and validated; values are only
// ever emitted as CSS custom properties, never as free-form CSS.

export interface HostSkin {
  mode?: "light" | "dark";
  font?: string;
  bg?: string;
  surface?: string;
  line?: string;
  ink?: string;
  muted?: string;
  accent?: string;
  accentInk?: string;
  radius?: string;
}

export const SKIN_STORAGE_KEY = "aram.skin.v1";
const TWEAKS_KEY = "aram.tweaks.v1";
const STYLE_ID = "host-skin";

const COLOR_KEYS = ["bg", "surface", "line", "ink", "muted", "accent", "accentInk"] as const;
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%]+\))$/;
const FONT_RE = /^[A-Za-z0-9 ,'"\-]{1,200}$/;
const RADIUS_RE = /^\d{1,2}(\.\d+)?(px|rem)$/;

function decodeBase64Url(raw: string): string {
  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseSkin(raw: string | null): HostSkin | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(decodeBase64Url(raw));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const out: HostSkin = {};
  if (d.mode === "light" || d.mode === "dark") out.mode = d.mode;
  if (typeof d.font === "string" && FONT_RE.test(d.font)) out.font = d.font;
  if (typeof d.radius === "string" && RADIUS_RE.test(d.radius)) out.radius = d.radius;
  for (const k of COLOR_KEYS) {
    const v = d[k];
    if (typeof v === "string" && COLOR_RE.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Maps onto tokens.css names. bg is the page level (--bg, --bg-1); surface is
 * cards/elevated (--bg-2, --bg-3, --bg-elev). tokens.css defines no radius
 * token, so `radius` is validated but not mapped to any variable.
 */
export function skinToCssVars(s: HostSkin): Record<string, string> {
  const v: Record<string, string> = {};
  if (s.bg) {
    v["--bg"] = s.bg;
    v["--bg-1"] = s.bg;
  }
  if (s.surface) {
    v["--bg-2"] = s.surface;
    v["--bg-3"] = s.surface;
    v["--bg-elev"] = s.surface;
  }
  if (s.line) {
    v["--line"] = s.line;
    v["--line-soft"] = s.line;
  }
  if (s.ink) {
    v["--ink"] = s.ink;
    v["--ink-1"] = s.ink;
  }
  if (s.muted) {
    v["--ink-2"] = s.muted;
    v["--ink-3"] = s.muted;
    v["--ink-4"] = s.muted;
  }
  if (s.accent) {
    v["--accent"] = s.accent;
    v["--accent-soft"] = `color-mix(in srgb, ${s.accent} 14%, transparent)`;
    v["--accent-ring"] = `color-mix(in srgb, ${s.accent} 35%, transparent)`;
  }
  if (s.accentInk) v["--accent-ink"] = s.accentInk;
  if (s.font) {
    v["--font-sans"] = s.font;
    v["--font-display"] = s.font;
  }
  return v;
}

// Specificity up to (0,4,0) vs tokens.css's max (0,2,0) for
// [data-theme][data-accent]; the later-injected <style> also wins ties.
export function skinToCss(s: HostSkin): string {
  const body = Object.entries(skinToCssVars(s))
    .map(([k, val]) => `${k}: ${val};`)
    .join(" ");
  const sel = [
    ':root[data-embed="1"]',
    ':root[data-embed="1"][data-theme]',
    ':root[data-embed="1"][data-theme][data-accent]',
  ].join(", ");
  return `${sel} { ${body} }`;
}

interface SkinDoc {
  getElementById(id: string): { remove?: () => void } | null;
  createElement(tag: string): { id: string; textContent: string | null };
  head: { appendChild(n: never): unknown };
  documentElement: { setAttribute(k: string, v: string): void };
}

export function applySkin(s: HostSkin, doc: SkinDoc = document as unknown as SkinDoc): void {
  if (s.mode) {
    doc.documentElement.setAttribute("data-theme", s.mode);
    try {
      const raw = localStorage.getItem(TWEAKS_KEY);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(TWEAKS_KEY, JSON.stringify({ ...prev, theme: s.mode }));
    } catch {
      /* storage unavailable */
    }
  }
  doc.getElementById(STYLE_ID)?.remove?.();
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = skinToCss(s);
  doc.head.appendChild(el as never);
  try {
    sessionStorage.setItem(SKIN_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Skin from the fragment, only when embedded; otherwise ignored. */
export function skinFromLocation(loc: { hash: string }, embedded: boolean): HostSkin | null {
  if (!embedded) return null;
  const h = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  return parseSkin(new URLSearchParams(h).get("skin"));
}

/** Re-read a previously applied skin (reload inside the iframe), re-validated. */
export function storedSkin(): HostSkin | null {
  try {
    const raw = sessionStorage.getItem(SKIN_STORAGE_KEY);
    return raw ? parseSkin(encodeBase64Url(raw)) : null;
  } catch {
    return null;
  }
}
