import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { WEBHOOK_TOLERANCE_S } from "./webhook-events";

/**
 * SP-27 webhook signatures (the scheme the developers page documents):
 *
 *   X-Crm-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
 *   v1 = hex(HMAC-SHA256(secret, `${t}.${rawBody}`))
 *
 * One v1 per active secret: during a rotation's 24 h overlap the previous
 * secret signs too, so receivers can switch over at their pace. A receiver
 * accepts when ANY v1 matches its secret (constant-time) and |now - t| is
 * within the tolerance (replay window, default 300 s).
 */
export const SIGNATURE_HEADER = "X-Crm-Signature";

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function hmac(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
}

/** The header value for `body` at `t` (unix seconds), signed by each secret. */
export function sign(secrets: string[], t: number, body: string): string {
  if (!secrets.length) throw new Error("no signing secret");
  return [`t=${t}`, ...secrets.map((s) => `v1=${hmac(s, t, body)}`)].join(",");
}

/** Reference verifier (also shown on the developers page). */
export function verify(
  secret: string,
  header: string | null | undefined,
  body: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = WEBHOOK_TOLERANCE_S,
): boolean {
  if (!header) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === null || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(hmac(secret, t, body), "hex");
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
