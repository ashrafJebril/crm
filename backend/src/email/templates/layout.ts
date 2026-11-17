/** SP-26 email layout: one language per email, `dir` on <html>, logical CSS
 *  (padding-inline, text-align: start), inline styles only. */
export type EmailLang = "ar" | "en";

export interface EmailBrand {
  /** Shown in the header; defaults to "tkana". */
  name?: string;
  /** CSS colour of the header bar and the button. */
  color?: string;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

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
  const color = brand?.color && SAFE_COLOR.test(brand.color) ? brand.color : "#0f766e";
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:Tahoma,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding-block:24px;padding-inline:16px">
<div style="background:${color};color:#ffffff;padding-block:12px;padding-inline:20px;border-radius:8px 8px 0 0;font-weight:bold;text-align:start">${name}</div>
<div style="background:#ffffff;padding-block:20px;padding-inline:20px;border-radius:0 0 8px 8px;text-align:start;line-height:1.6">
${bodyHtml}
</div>
</div>
</body>
</html>`;
}

/** A call-to-action button; `href` is escaped. */
export function button(href: string, label: string, brand?: EmailBrand): string {
  const color = brand?.color && SAFE_COLOR.test(brand.color) ? brand.color : "#0f766e";
  return `<p style="text-align:start;margin-block:20px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding-block:10px;padding-inline:18px;border-radius:6px">${escapeHtml(label)}</a></p>`;
}
