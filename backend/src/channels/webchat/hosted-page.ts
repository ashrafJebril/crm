import { CHAT_PAGE_JS } from "./assets/chat-page.js";
import { allowedOriginsFrom, frameAncestorsFor, originOptions, type OriginOptions } from "./origin-match";

export type WidgetLang = "en" | "ar";

export interface ChatPageInput {
  channel: { id: string; displayName: string; config: unknown };
  lang: WidgetLang;
  /** true = inside the loader's iframe; false = the hosted chat page link. */
  embed: boolean;
  nonce: string;
  /** The API's own origin, e.g. https://api.example.com. */
  apiOrigin: string;
  /** The verified embedding origin (embed mode), or null. */
  parent?: string | null;
  /** The API path prefix the page calls (default "/api"). */
  apiBase?: string;
  originOpts?: OriginOptions;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** HTML-escape text for element content and double-quoted attributes. */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);
}

const COPY = {
  en: { placeholder: "Type a message…", send: "Send", name: "Your name (optional)", close: "Close chat", noscript: "Please enable JavaScript to chat with us.", chat: "Chat" },
  ar: { placeholder: "اكتب رسالة…", send: "إرسال", name: "اسمك (اختياري)", close: "أغلق المحادثة", noscript: "يُرجى تفعيل JavaScript لبدء المحادثة.", chat: "المحادثة" },
} as const;

const CSS = `:root{--wc:#111827;color-scheme:light}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",Tahoma,sans-serif;background:#f6f7f9;color:#111827}
.wc{display:flex;flex-direction:column;height:100%;max-width:720px;margin-inline:auto;background:#fff}
.wc-head{display:flex;align-items:center;gap:8px;padding:14px 16px;background:var(--wc);color:#fff}
.wc-title{flex:1;margin:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wc-close{border:0;background:transparent;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
.wc-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.wc-msg{display:flex}.wc-msg p{margin:0;max-width:80%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.wc-them{justify-content:flex-start}.wc-them p{background:#eef0f3;border-end-start-radius:4px}
.wc-me{justify-content:flex-end}.wc-me p{background:var(--wc);color:#fff;border-end-end-radius:4px}
.wc-status{margin:0;padding:0 16px;min-height:1.2em;font-size:13px;color:#b42318}
.wc-form{display:flex;flex-direction:column;gap:8px;padding:12px 16px 16px;border-top:1px solid #e5e7eb}
.wc-row{display:flex;gap:8px;align-items:flex-end}
.wc-form input,.wc-form textarea{font:inherit;border:1px solid #d0d5dd;border-radius:10px;padding:9px 12px;width:100%}
.wc-form textarea{resize:none;min-height:42px;max-height:120px}
.wc-send{border:0;border-radius:10px;padding:10px 16px;background:var(--wc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.wc-send:disabled{opacity:.6;cursor:default}[hidden]{display:none!important}`;

/**
 * The hosted chat page (`GET /api/chat/:channelId`), pure.
 *
 * - Every interpolated value is HTML-escaped (display name, labels, data-*).
 *   The greeting is not rendered here; the client sets it with textContent.
 * - CSP: `default-src 'none'; script-src 'self' 'nonce-<n>'; style-src
 *   'nonce-<n>'; connect-src 'self' <ws(s)-origin>; img-src 'self' data:;
 *   base-uri 'none'; form-action 'none'; frame-ancestors <...>`.
 *   frame-ancestors is the channel's (re-validated) allowedOrigins in embed
 *   mode, and `'none'` for the direct link (and for an embed with no
 *   allowed origin).
 */
export function renderChatPage(input: ChatPageInput): { html: string; csp: string } {
  const { channel, lang, embed, nonce, apiOrigin } = input;
  const opts = input.originOpts ?? originOptions();
  const t = COPY[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const apiBase = input.apiBase ?? "/api";
  const n = escapeHtml(nonce);
  const name = escapeHtml(channel.displayName || t.chat);

  const ancestors = embed ? frameAncestorsFor(allowedOriginsFrom(channel.config, opts)) : "'none'";
  const wsOrigin = apiOrigin.replace(/^http/, "ws");
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `connect-src 'self' ${wsOrigin}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");

  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${name}</title>
<style nonce="${n}">${CSS}</style>
</head>
<body data-channel="${escapeHtml(channel.id)}" data-lang="${lang}" data-embed="${embed ? "1" : "0"}" data-parent="${escapeHtml(embed ? input.parent ?? "" : "")}" data-api="${escapeHtml(apiBase)}">
<div class="wc">
<header class="wc-head"><h1 class="wc-title" dir="auto">${name}</h1><button id="wc-close" class="wc-close" type="button" aria-label="${escapeHtml(t.close)}" hidden>×</button></header>
<main id="wc-log" class="wc-log" aria-live="polite"></main>
<p id="wc-status" class="wc-status" role="status"></p>
<form id="wc-form" class="wc-form" autocomplete="off">
<input id="wc-name" type="text" maxlength="80" placeholder="${escapeHtml(t.name)}" aria-label="${escapeHtml(t.name)}" dir="auto" hidden>
<div class="wc-row"><textarea id="wc-input" rows="1" maxlength="2000" placeholder="${escapeHtml(t.placeholder)}" aria-label="${escapeHtml(t.placeholder)}" dir="auto" required></textarea><button id="wc-send" class="wc-send" type="submit">${escapeHtml(t.send)}</button></div>
</form>
<noscript><p class="wc-status">${escapeHtml(t.noscript)}</p></noscript>
</div>
<script nonce="${n}">${CHAT_PAGE_JS}</script>
</body>
</html>`;
  return { html, csp };
}
