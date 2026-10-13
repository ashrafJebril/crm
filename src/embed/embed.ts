// Embed mode: the CRM runs inside a cross-origin iframe in the Tiremall admin.
// All parent communication goes through postMessage with an explicit
// targetOrigin (never "*") and origin-checked inbound messages.

export const EMBED_KEY = "aram.embed.v1";

export type EmbedOutbound =
  | { type: "kewy:ready" }
  | { type: "kewy:route"; route: string }
  | { type: "kewy:sso-failed" };

export type EmbedInbound =
  | { type: "kewy:navigate"; route: string }
  | { type: "kewy:visibility"; visible: boolean }
  | { type: "kewy:connected"; provider: string };

// In-memory flag so embed mode survives sessionStorage being unavailable
// (otherwise the Login form could render inside the iframe).
let embedded = false;

export function isEmbedded(): boolean {
  if (embedded) return true;
  try {
    return sessionStorage.getItem(EMBED_KEY) === "1";
  } catch {
    return false;
  }
}

export type AuthScreen = "loading" | "login" | "embed-failed" | "app";

export function authScreen(
  status: "loading" | "anonymous" | "authenticated",
  embedded: boolean,
): AuthScreen {
  if (status === "loading") return "loading";
  if (status === "anonymous") return embedded ? "embed-failed" : "login";
  return "app";
}

export function markEmbedded(): void {
  embedded = true;
  try {
    sessionStorage.setItem(EMBED_KEY, "1");
  } catch {
    /* ignore */
  }
  if (typeof document !== "undefined") document.documentElement.dataset.embed = "1";
}

/**
 * A `#tmsso` fragment is only honoured when this load is an embed (`?embed=1`)
 * AND actually framed. A top-level page carrying `#tmsso` is ignored entirely:
 * no exchange, and the existing session is left untouched.
 */
export function shouldConsumeTiremallSso(search: string, win: Window): boolean {
  if (new URLSearchParams(search).get("embed") !== "1") return false;
  try {
    return win.parent !== win;
  } catch {
    return true; // cross-origin parent access threw -> we are framed
  }
}

export function allowedParentOrigins(
  raw: string | undefined = import.meta.env.VITE_EMBED_PARENT_ORIGINS as string | undefined,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedParent(origin: string, allowed: string[] = allowedParentOrigins()): boolean {
  return allowed.includes(origin);
}

function referrerOrigin(): string | null {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

export function postToParent(msg: EmbedOutbound): void {
  if (typeof window === "undefined" || !isEmbedded() || window.parent === window) return;
  const allowed = allowedParentOrigins();
  const anc = window.location.ancestorOrigins?.[0];
  const ref = referrerOrigin();
  const target =
    anc && isAllowedParent(anc, allowed)
      ? anc
      : ref && isAllowedParent(ref, allowed)
        ? ref
        : allowed[0];
  if (!target) return;
  window.parent.postMessage(msg, target);
}

export function parseInbound(
  e: MessageEvent,
  allowed: string[] = allowedParentOrigins(),
): EmbedInbound | null {
  const d = e.data as { type?: unknown; route?: unknown; provider?: unknown; visible?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  if (d.type === "kewy:navigate") {
    if (e.source !== window.parent || !isAllowedParent(e.origin, allowed)) return null;
    return typeof d.route === "string" ? { type: "kewy:navigate", route: d.route } : null;
  }
  if (d.type === "kewy:visibility") {
    if (e.source !== window.parent || !isAllowedParent(e.origin, allowed)) return null;
    return typeof d.visible === "boolean" ? { type: "kewy:visibility", visible: d.visible } : null;
  }
  if (d.type === "kewy:connected") {
    if (e.origin !== window.location.origin) return null;
    return typeof d.provider === "string" ? { type: "kewy:connected", provider: d.provider } : null;
  }
  return null;
}

export const CONNECT_WINDOW_NAME = "kewy-connect";

export type ConnectHandle = Window;

/**
 * Embedded only: open the connect popup SYNCHRONOUSLY inside the click handler
 * (before any await) so popup blockers allow it. Returns null if blocked.
 */
export function beginConnectWindow(): ConnectHandle | null {
  return window.open("about:blank", CONNECT_WINDOW_NAME, "width=600,height=750");
}

export function navigateConnectWindow(handle: ConnectHandle, url: string): void {
  handle.location.href = url;
}

export function abortConnectWindow(handle: ConnectHandle): void {
  try {
    handle.close();
  } catch {
    /* ignore */
  }
}

/**
 * Fallback for when COOP severs window.opener: poll the popup handle and call
 * onClosed once it closes. Stops after maxMs. Returns a stop function.
 */
export function watchConnectWindow(
  handle: ConnectHandle,
  onClosed: () => void,
  intervalMs = 1000,
  maxMs = 10 * 60_000,
): () => void {
  const started = Date.now();
  const timer = setInterval(() => {
    let closed = false;
    try {
      closed = handle.closed;
    } catch {
      closed = true;
    }
    if (closed) {
      clearInterval(timer);
      onClosed();
    } else if (Date.now() - started >= maxMs) {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Which connect callback (if any) is this page load? Pure, for boot-time use. */
export function connectCallbackProvider(loc: {
  search: string;
  hash: string;
}): "facebook" | "zernio" | null {
  if (new URLSearchParams(loc.search).get("fb") === "connected") return "facebook";
  const h = loc.hash.replace(/^#/, "");
  const q = h.indexOf("?");
  if (q >= 0) {
    const route = h.slice(0, q).replace(/^\/+/, "");
    if (route === "settings" && new URLSearchParams(h.slice(q + 1)).get("zernio") === "connected") {
      return "zernio";
    }
  }
  return null;
}

/** Called in the popup after a completed connect. True means the popup is closing. */
export function notifyOpenerConnected(provider: string): boolean {
  if (typeof window === "undefined") return false;
  if (!window.opener || window.name !== CONNECT_WINDOW_NAME) return false;
  window.opener.postMessage({ type: "kewy:connected", provider }, window.location.origin);
  window.close();
  return true;
}
