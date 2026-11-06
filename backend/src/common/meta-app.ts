import * as crypto from "node:crypto";

/**
 * Single source of truth for which Meta app the backend talks to.
 *
 * Tech Provider rollout: we're moving from two Meta apps (FB/IG on
 * META_APP_ID, WhatsApp on META_APP_ID_WA) to ONE app (META_APP_ID). Until
 * Meta approves us, META_TECH_PROVIDER_ENABLED stays off and every WhatsApp
 * path keeps using the legacy WA app exactly as before. Flip it to "true"
 * after approval to switch WhatsApp onto the single app and show the new
 * popup connect buttons.
 */

export function techProviderEnabled(): boolean {
  return process.env.META_TECH_PROVIDER_ENABLED === "true";
}

export interface MetaAppCreds {
  appId: string | undefined;
  appSecret: string | undefined;
}

function mainApp(): MetaAppCreds {
  return { appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET };
}

function legacyWaApp(): MetaAppCreds {
  return { appId: process.env.META_APP_ID_WA, appSecret: process.env.META_APP_SECRET_WA };
}

/** App used for WhatsApp token exchange / debug_token. */
export function whatsappApp(): MetaAppCreds {
  const main = mainApp();
  if (techProviderEnabled()) return main;
  const wa = legacyWaApp();
  return {
    appId: wa.appId ?? main.appId,
    appSecret: wa.appSecret ?? main.appSecret,
  };
}

/**
 * Secrets accepted for a webhook route, preferred first. The WhatsApp route
 * accepts both apps while customers connected through the legacy WA app are
 * still live (their WABAs are subscribed to that app and it signs with its
 * own secret).
 */
export function metaWebhookSecrets(route: "whatsapp" | "meta"): string[] {
  const main = process.env.META_APP_SECRET;
  const wa = process.env.META_APP_SECRET_WA;
  const ordered =
    route === "meta" ? [main] : techProviderEnabled() ? [main, wa] : [wa, main];
  return [...new Set(ordered.filter((s): s is string => !!s))];
}

/** Every secret that could have signed a Meta callback (deauth / deletion). */
export function allMetaAppSecrets(): string[] {
  return [
    ...new Set(
      [process.env.META_APP_SECRET, process.env.META_APP_SECRET_WA].filter(
        (s): s is string => !!s,
      ),
    ),
  ];
}

export interface SignedRequestPayload {
  algorithm?: string;
  user_id?: string;
  issued_at?: number;
  [k: string]: unknown;
}

function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
}

/**
 * Parse + verify Meta's `signed_request` (deauthorize & data-deletion
 * callbacks): `<b64url hmac-sha256 sig>.<b64url json payload>`, HMAC keyed by
 * the app secret over the encoded payload. Returns null on any failure.
 */
export function parseSignedRequest(
  signedRequest: string | undefined,
  secrets: string[],
): SignedRequestPayload | null {
  if (!signedRequest || secrets.length === 0) return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedSig, encodedPayload] = parts;

  let payload: SignedRequestPayload;
  try {
    payload = JSON.parse(b64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.algorithm?.toUpperCase() !== "HMAC-SHA256") return null;

  const sig = b64urlDecode(encodedSig);
  const ok = secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(encodedPayload).digest();
    return expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
  });
  return ok ? payload : null;
}
