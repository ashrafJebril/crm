/**
 * SP-21 page discovery. Pure, linear scans (no backtracking regexes on page
 * input): `<loc>` entries of a sitemap (or sitemap index) and `href`s of
 * anchors. Page content is untrusted: only URLs come out, and the crawler
 * still checks each against the site's origin, scope and robots rules.
 */

export const MAX_LINKS_PER_PAGE = 500;
export const MAX_SITEMAP_URLS = 2000;

/** `<loc>…</loc>` values, entity-decoded, at most `max`. */
export function sitemapLocs(xml: string, max = MAX_SITEMAP_URLS): string[] {
  const out: string[] = [];
  const lower = xml.toLowerCase();
  let from = 0;
  while (out.length < max) {
    const open = lower.indexOf("<loc>", from);
    if (open < 0) break;
    const close = lower.indexOf("</loc>", open + 5);
    if (close < 0) break;
    const value = xml.slice(open + 5, close).trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/&amp;/g, "&");
    if (value) out.push(value);
    from = close + 6;
  }
  return out;
}

/** Whether a sitemap is an index of sitemaps. */
export function isSitemapIndex(xml: string): boolean {
  return xml.slice(0, 2000).toLowerCase().includes("<sitemapindex");
}

/** Absolute URLs of `<a href>` links on an HTML page (resolved against `base`), at most `max`. */
export function pageLinks(html: string, base: URL, max = MAX_LINKS_PER_PAGE): URL[] {
  const out: URL[] = [];
  const lower = html.toLowerCase();
  let from = 0;
  while (out.length < max) {
    const a = lower.indexOf("<a", from);
    if (a < 0) break;
    const end = lower.indexOf(">", a);
    if (end < 0) break;
    from = end + 1;
    const next = lower.charCodeAt(a + 2);
    // `<a ` / `<a\n` only, not `<abbr>` or `<area>`.
    if (!(next === 32 || next === 9 || next === 10 || next === 13)) continue;
    const tag = html.slice(a, end);
    const m = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const href = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim().replace(/&amp;/g, "&");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      out.push(new URL(href, base));
    } catch {
      // not a URL
    }
  }
  return out;
}

/** The page `<title>` (first one), trimmed to 300 chars, or null. */
export function pageTitle(html: string): string | null {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return null;
  const gt = lower.indexOf(">", open);
  const close = lower.indexOf("</title>", gt + 1);
  if (gt < 0 || close < 0) return null;
  const t = html.slice(gt + 1, close).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 300) : null;
}
