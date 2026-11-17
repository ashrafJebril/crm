import { randomBytes } from "node:crypto";

export interface CallbackOutcome {
  connected: boolean;
  connectorId: string | null;
  reason: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * The OAuth hand-off page. One nonce'd script posts the outcome to the
 * opener at the FRONTEND origin only (never "*") and closes; without an
 * opener it goes to the connectors tab. No token, code or state ever
 * appears in it. Headers: no-store, no-referrer and a CSP that allows only
 * that script.
 */
export function callbackPage(outcome: CallbackOutcome, frontendOrigin: string, fallbackUrl: string): { html: string; headers: Record<string, string> } {
  const nonce = randomBytes(16).toString("base64");
  const message = JSON.stringify({ type: "kewy-connector-oauth", connected: outcome.connected, connectorId: outcome.connectorId, reason: outcome.reason });
  const script = `(function(){var m=${message};var o=${JSON.stringify(frontendOrigin)};try{if(window.opener){window.opener.postMessage(m,o);window.close();return}}catch(e){}window.location.replace(${JSON.stringify(fallbackUrl)})})();`;
  const title = outcome.connected ? "Connected" : "Not connected";
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title></head>` +
    `<body><p>${esc(title)}. You can close this window.</p><p dir="rtl">${outcome.connected ? "تم الربط" : "لم يتم الربط"}. يمكنك إغلاق هذه النافذة.</p>` +
    `<p><a href="${esc(fallbackUrl)}">Continue</a></p><script nonce="${nonce}">${script.replace(/</g, "\u003c")}</script></body></html>`;
  return {
    html,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
    },
  };
}
