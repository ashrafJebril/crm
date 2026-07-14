import * as crypto from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 *
 * Meta signs every webhook POST with `sha256=<hex hmac>` where the HMAC key is
 * the app secret and the message is the *exact raw bytes* of the request body
 * (not the re-serialized JSON — which is why the caller must pass the raw
 * Buffer captured before body parsing).
 *
 * Fails closed: a missing secret, missing header, missing body, or any length
 * mismatch returns false. Comparison is constant-time.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !rawBody || rawBody.length === 0) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first (the length itself
  // isn't secret: it's fixed at 71 chars for sha256=).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
