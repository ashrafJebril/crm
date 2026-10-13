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
  const d = e.data as { type?: unknown; route?: unknown; provider?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  if (d.type === "kewy:navigate") {
    if (e.source !== window.parent || !isAllowedParent(e.origin, allowed)) return null;
    return typeof d.route === "string" ? { type: "kewy:navigate", route: d.route } : null;
  }
  if (d.type === "kewy:connected") {
    if (e.origin !== window.location.origin) return null;
    return typeof d.provider === "string" ? { type: "kewy:connected", provider: d.provider } : null;
  }
  return null;
}
