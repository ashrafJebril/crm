/** SP-26 email layout: one language per email, `dir` on <html>, logical CSS
 *  (padding-inline, text-align: start), inline styles only.
 *  SP-29: the workspace brand: a 4 px top bar in the brand colour, the logo
 *  (absolute http(s) URL, at most 120×40, alt = the workspace name), and the
 *  button's text in the higher-contrast ink. */
import { brandInk, safeBrandColor } from "../../workspaces/brand-color";

export type EmailLang = "ar" | "en";

export interface EmailBrand {
  /** Shown in the header; defaults to "tkana". */
  name?: string;
  /** CSS colour of the header bar and the button. */
  color?: string;
  /** SP-29: absolute public URL of the workspace logo. */
  logoUrl?: string | null;
}

/** The brand colour as `#rrggbb`, or null (anything else is ignored). */
const colorOf = (brand?: EmailBrand) => safeBrandColor(brand?.color ?? null);
const DEFAULT_COLOR = "#0f766e";
/** Only an absolute http(s) URL with no quote, space or angle bracket. */
const safeLogo = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function emailLang(v: unknown): EmailLang {
  return v === "en" ? "en" : "ar";
}

export interface LayoutInput {
  lang: EmailLang;
  title: string;
  /** Already-escaped HTML for the body. */
  bodyHtml: string;
  brand?: EmailBrand;
}

export function layout({ lang, title, bodyHtml, brand }: LayoutInput): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const name = escapeHtml(brand?.name?.trim() || "tkana");
  const color = colorOf(brand) ?? DEFAULT_COLOR;
  const logo = safeLogo(brand?.logoUrl);
  const head = logo
    ? `<img src="${escapeHtml(logo)}" alt="${name}" style="display:block;max-width:120px;max-height:40px;width:auto;height:auto;border:0">`
    : `<span style="font-weight:bold">${name}</span>`;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:Tahoma,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding-block:24px;padding-inline:16px">
<div style="height:4px;background:${color};border-radius:8px 8px 0 0;font-size:0;line-height:0">&nbsp;</div>
<div style="background:#ffffff;color:#18181b;padding-block:12px;padding-inline:20px;border-block-end:1px solid #e4e4e7;text-align:start">${head}</div>
<div style="background:#ffffff;padding-block:20px;padding-inline:20px;border-radius:0 0 8px 8px;text-align:start;line-height:1.6">
${bodyHtml}
</div>
</div>
</body>
</html>`;
}

/** A call-to-action button; `href` is escaped. */
export function button(href: string, label: string, brand?: EmailBrand): string {
  const color = colorOf(brand) ?? DEFAULT_COLOR;
  return `<p style="text-align:start;margin-block:20px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:${brandInk(color)};text-decoration:none;padding-block:10px;padding-inline:18px;border-radius:6px">${escapeHtml(label)}</a></p>`;
}
