import { channelError } from "../channel-errors";

/**
 * Web chat origin rules (SP-19 T3, Global Constraints "Widget security").
 *
 * A pattern is one of:
 *  - `https://host[:port]`, an exact origin;
 *  - `https://*.example.com`, any subdomain of example.com (not the apex),
 *    matched label by label: `shop.com.evil.io` never matches `*.shop.com`;
 *  - outside production only: `http://localhost[:port|:*]` or
 *    `http://127.0.0.1[:port|:*]`.
 * No path, query, credentials or catch-all `*`. Production is https-only.
 *
 * Stored patterns are never trusted: every read goes through
 * `allowedOriginsFrom`, which re-validates under the current environment
 * (M2), so an http entry saved in dev is ignored once NODE_ENV=production.
 */
export interface OriginOptions {
  production: boolean;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";
export const originOptions = (): OriginOptions => ({ production: isProduction() });

export const MAX_ALLOWED_ORIGINS = 20;
export const MAX_GREETING = 280;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const POSITIONS = ["start", "end"] as const;
export const LANGS = ["en", "ar"] as const;

const PATTERN_RE = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}|\*))?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const DEFAULT_PORT: Record<string, string> = { https: "443", http: "80" };

interface Parsed {
  scheme: string;
  wildcard: boolean;
  host: string;
  /** "" = default port, "*" = any port (localhost only). */
  port: string;
}

function validHost(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  return labels.every((l) => LABEL_RE.test(l));
}

function parsePattern(raw: unknown, opts: OriginOptions): Parsed | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  const m = PATTERN_RE.exec(s);
  if (!m) return null;
  const [, scheme, star, host, portRaw] = m;
  let port = portRaw ?? "";
  if (!validHost(host)) return null;
  if (port && port !== "*") {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    port = String(n) === DEFAULT_PORT[scheme] ? "" : String(n);
  }
  const wildcard = !!star;
  if (scheme === "http") {
    if (opts.production || wildcard || !LOCAL_HOSTS.has(host)) return null;
    return { scheme, wildcard, host, port };
  }
  if (port === "*") return null;
  // `*.com` would be a catch-all for a TLD: a wildcard needs two labels.
  if (wildcard && host.split(".").length < 2) return null;
  return { scheme, wildcard, host, port };
}

function format(p: Parsed): string {
  return `${p.scheme}://${p.wildcard ? "*." : ""}${p.host}${p.port ? `:${p.port}` : ""}`;
}

/** The canonical form of a valid pattern, or null when it is not allowed. */
export function normalizeOriginPattern(raw: unknown, opts: OriginOptions): string | null {
  const p = parsePattern(raw, opts);
  return p ? format(p) : null;
}

/** A concrete browser origin (`Origin` header, `parent`) in parts, or null. */
function parseOrigin(origin: unknown): { scheme: string; host: string; port: string } | null {
  if (typeof origin !== "string" || !origin || origin.length > 300) return null;
  const m = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(origin.trim().toLowerCase());
  if (!m) return null;
  const [, scheme, host, portRaw] = m;
  if (!validHost(host)) return null;
  const port = portRaw && portRaw !== DEFAULT_PORT[scheme] ? String(Number(portRaw)) : "";
  return { scheme, host, port };
}

/** True when a concrete origin satisfies one (already normalized) pattern. */
export function originMatches(origin: string, pattern: string): boolean {
  const o = parseOrigin(origin);
  // Patterns passed here were normalized under some environment; parse them
  // leniently (dev rules) — the environment check happened in allowedOriginsFrom.
  const p = parsePattern(pattern, { production: false });
  if (!o || !p || o.scheme !== p.scheme) return false;
  if (p.port !== "*" && o.port !== p.port) return false;
  if (!p.wildcard) return o.host === p.host;
  return o.host.length > p.host.length + 1 && o.host.endsWith(`.${p.host}`);
}

/** The stored `allowedOrigins`, re-validated and normalized (M2). Invalid entries are dropped. */
export function allowedOriginsFrom(config: unknown, opts: OriginOptions): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const list = (config as { allowedOrigins?: unknown }).allowedOrigins;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list.slice(0, MAX_ALLOWED_ORIGINS)) {
    const n = normalizeOriginPattern(raw, opts);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function isAllowedOrigin(origin: string, config: unknown, opts: OriginOptions): boolean {
  return allowedOriginsFrom(config, opts).some((p) => originMatches(origin, p));
}

/** The CSP `frame-ancestors` source list. Patterns are already canonical, so
 *  they are valid CSP host sources (`https://*.shop.com`, `http://localhost:*`). */
export function frameAncestorsFor(patterns: string[]): string {
  return patterns.length ? patterns.join(" ") : "'none'";
}

/**
 * Validate the member-editable web chat config keys (`POST /channels`,
 * `PATCH /channels/:id`). Returns the sanitized subset; throws 400
 * `channels.invalid_config {field}` on the first bad value. `null` clears an
 * optional field.
 */
export function validateWebchatConfig(config: Record<string, unknown> | undefined, opts: OriginOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!config) return out;
  const fail = (field: string) => channelError("channels.invalid_config", { field });

  if (config.allowedOrigins !== undefined) {
    const list = config.allowedOrigins;
    if (!Array.isArray(list) || list.length > MAX_ALLOWED_ORIGINS) throw fail("allowedOrigins");
    const norm: string[] = [];
    for (const raw of list) {
      const n = normalizeOriginPattern(raw, opts);
      if (!n) throw fail("allowedOrigins");
      if (!norm.includes(n)) norm.push(n);
    }
    out.allowedOrigins = norm;
  }
  for (const key of ["greeting", "greetingAr"] as const) {
    const v = config[key];
    if (v === undefined) continue;
    if (v === null) {
      out[key] = null;
      continue;
    }
    if (typeof v !== "string") throw fail(key);
    const t = v.trim();
    if (t.length > MAX_GREETING) throw fail(key);
    out[key] = t;
  }
  if (config.color !== undefined) {
    if (config.color !== null && (typeof config.color !== "string" || !COLOR_RE.test(config.color))) throw fail("color");
    out.color = config.color;
  }
  if (config.position !== undefined) {
    if (!(POSITIONS as readonly unknown[]).includes(config.position)) throw fail("position");
    out.position = config.position;
  }
  if (config.askName !== undefined) {
    if (typeof config.askName !== "boolean") throw fail("askName");
    out.askName = config.askName;
  }
  if (config.lang !== undefined) {
    if (config.lang !== null && !(LANGS as readonly unknown[]).includes(config.lang)) throw fail("lang");
    out.lang = config.lang;
  }
  return out;
}
