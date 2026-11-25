/**
 * SP-21 website URLs. Pure.
 *
 * A site is an origin: `https`, the default port, and the host with a
 * leading `www.` folded (so `www.shop.example` and `shop.example` are one
 * site). The crawler never leaves it; with scope `path`, it also stays under
 * the start path. A page's key drops the scheme, `www.`, the fragment, the
 * tracking parameters and a trailing slash, so one page has one row.
 */

export type WebsiteScope = "site" | "path";

export interface Site {
  /** The host without `www.`, lower-case. */
  host: string;
  /** The start URL (normalised). */
  start: URL;
  scope: WebsiteScope;
  /** Scope `path`: the start path with a trailing slash ("/blog/"); "/" for `site`. */
  prefix: string;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|mc_cid|mc_eid|msclkid|yclid|_ga|_gl|ref)$/i;

export const bareHost = (host: string) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Remove the fragment and tracking parameters, sort the rest. */
export function cleanUrl(url: URL): URL {
  const u = new URL(url.toString());
  u.hash = "";
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u;
}

/** The page key: host without www + path without trailing slash + sorted non-tracking query. */
export function urlKey(url: URL): string {
  const u = cleanUrl(url);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${bareHost(u.hostname)}${path}${u.search}`;
}

/** https, default port, no credentials. */
export function isHttpsDefault(url: URL): boolean {
  return url.protocol === "https:" && (!url.port || url.port === "443") && !url.username && !url.password;
}

export function siteOf(start: URL, scope: WebsiteScope): Site {
  const s = cleanUrl(start);
  const dir = s.pathname.endsWith("/") ? s.pathname : `${s.pathname}/`;
  return { host: bareHost(s.hostname), start: s, scope, prefix: scope === "path" ? dir : "/" };
}

/** Same origin as the site: https, default port, same host once `www.` is folded. */
export function sameOrigin(site: Site, url: URL): boolean {
  return isHttpsDefault(url) && bareHost(url.hostname) === site.host;
}

/** Same origin and, for scope `path`, under the start path (the start path itself included). */
export function inScope(site: Site, url: URL): boolean {
  if (!sameOrigin(site, url)) return false;
  if (site.scope === "site") return true;
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return path.startsWith(site.prefix);
}

/**
 * A member's input → an https URL, or null when it is not a web address at
 * all. A bare host gets `https://`; an `http:` URL is upgraded (the caller
 * checks that https answers).
 */
export function normalizeInputUrl(raw: string): { url: URL; wasHttp: boolean } | null {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2000 || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const wasHttp = url.protocol === "http:";
  if (url.protocol !== "https:" && !wasHttp) return null;
  if (url.username || url.password) return null;
  if (wasHttp) {
    if (url.port && url.port !== "80") return null;
    url = new URL(`https://${url.hostname}${url.pathname}${url.search}`);
  }
  if (url.port && url.port !== "443") return null;
  return { url: cleanUrl(url), wasHttp };
}
