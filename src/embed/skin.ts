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
const STYLE_ID = "host-skin";

const COLOR_KEYS = ["bg", "surface", "line", "ink", "muted", "accent", "accentInk"] as const;
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(,\s*(0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/;
const isColor = (v: string) => HEX_RE.test(v) || RGB_RE.test(v);
const count = (str: string, ch: string) => str.split(ch).length - 1;
const FONT_RE = /^[A-Za-z0-9 ,'"\-]{1,200}$/;
const RADIUS_RE = /^\d{1,2}(\.\d+)?(px|rem)$/;

function decodeBase64Url(raw: string): string {
  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function validateSkin(data: unknown): HostSkin | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const out: HostSkin = {};
  if (d.mode === "light" || d.mode === "dark") out.mode = d.mode;
  if (
    typeof d.font === "string" &&
    FONT_RE.test(d.font) &&
    count(d.font, "'") % 2 === 0 &&
    count(d.font, '"') % 2 === 0
  ) {
    out.font = d.font;
  }
  if (typeof d.radius === "string" && RADIUS_RE.test(d.radius)) out.radius = d.radius;
  for (const k of COLOR_KEYS) {
    const v = d[k];
    if (typeof v === "string" && isColor(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function parseSkin(raw: string | null): HostSkin | null {
  if (!raw) return null;
  try {
    return validateSkin(JSON.parse(decodeBase64Url(raw)));
  } catch {
    return null;
  }
}

// tokens.css radius scale: xs 4, sm 6, r 8, md 10, lg 14, xl 20 (px).
// --r and --r-md take the host radius; the rest scale from the 8px base.
const RADIUS_SCALE: Record<string, number> = {
  "--r-xs": 0.5,
  "--r-sm": 0.75,
  "--r-lg": 1.75,
  "--r-xl": 2.5,
};

/**
 * Maps onto tokens.css names. bg is the page level (--bg, --bg-1); surface is
 * cards/elevated (--bg-2, --bg-3, --bg-elev).
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
    v["--ink-3"] = `color-mix(in srgb, ${s.muted} 80%, transparent)`;
    v["--ink-4"] = `color-mix(in srgb, ${s.muted} 60%, transparent)`;
  }
  if (s.accent) {
    v["--accent"] = s.accent;
    v["--accent-soft"] = `color-mix(in srgb, ${s.accent} 14%, transparent)`;
    v["--accent-ring"] = `color-mix(in srgb, ${s.accent} 35%, transparent)`;
    v["--bubble-out"] = `color-mix(in srgb, ${s.accent} 18%, transparent)`;
    v["--bubble-out-line"] = `color-mix(in srgb, ${s.accent} 45%, transparent)`;
  }
  if (s.accentInk) v["--accent-ink"] = s.accentInk;
  if (s.font) {
    v["--font-sans"] = s.font;
    v["--font-display"] = s.font;
  }
  if (s.radius) {
    v["--r"] = s.radius;
    v["--r-md"] = s.radius;
    for (const [k, f] of Object.entries(RADIUS_SCALE)) v[k] = `calc(${s.radius} * ${f})`;
  }
  return v;
}

/** Vars for `.inbox-v2`, which re-declares the palette on its own scope. */
export function skinToInboxVars(s: HostSkin): Record<string, string> {
  const v = skinToCssVars(s);
  if (s.accent) {
    // Solid accent bubbles (as .inbox-v2 does) with the host's on-accent ink.
    v["--bubble-out"] = s.accent;
    v["--ix-green-strong"] = `color-mix(in srgb, ${s.accent} 85%, black)`;
  }
  if (s.accentInk) v["--bubble-out-ink"] = s.accentInk;
  return v;
}

const decls = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, val]) => `${k}: ${val};`)
    .join(" ");

// Specificity up to (0,4,0) vs tokens.css's max (0,2,0) for
// [data-theme][data-accent], and (0,2,0) for [data-theme="light"] .inbox-v2.
export function skinToCss(s: HostSkin): string {
  const root = [
    ':root[data-embed="1"]',
    ':root[data-embed="1"][data-theme]',
    ':root[data-embed="1"][data-theme][data-accent]',
  ];
  const inbox = root.map((r) => `${r} .inbox-v2`);
  const parts = [`${root.join(", ")} { ${decls(skinToCssVars(s))} }`];
  const iv = decls(skinToInboxVars(s));
  const font = s.font ? " font-family: var(--font-sans);" : "";
  parts.push(`${inbox.join(", ")} { ${iv}${font} }`);
  if (s.font) {
    parts.push(
      `${inbox.map((i) => `${i} .ix-display`).join(", ")} { font-family: var(--font-display); }`,
    );
  }
  return parts.join("\n");
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
    return raw ? validateSkin(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
