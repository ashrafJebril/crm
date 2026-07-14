import * as crypto from "node:crypto";

/**
 * Encryption-at-rest for stored third-party access tokens (Meta page/WABA
 * tokens on the Integration table).
 *
 * Opt-in and backward-compatible:
 *  - If `TOKEN_ENC_KEY` is set (>= 32 chars), new writes are encrypted with
 *    AES-256-GCM and reads transparently decrypt.
 *  - If it is unset, encryptSecret is a no-op (stores plaintext, exactly as
 *    before) so nothing breaks in dev / existing deployments.
 *  - decryptSecret always passes through values that lack the `enc:v1:` prefix,
 *    so a database still holding legacy plaintext keeps working after the key
 *    is introduced — no migration required for reads.
 *
 * To enable in production: set TOKEN_ENC_KEY to a long random string and
 * (optionally) re-save each integration so its token gets rewritten encrypted.
 */
const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k || k.length < 32) return null;
  // Derive a fixed 32-byte key from whatever length string is provided.
  return crypto.createHash("sha256").update(k).digest();
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) return plain; // encryption disabled — behave exactly as before
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(stored: string): string;
export function decryptSecret(stored: string | null): string | null;
export function decryptSecret(stored: string | null): string | null {
  if (stored == null || !stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const k = key();
  if (!k) return stored; // no key to decrypt with — pass through (fails upstream, doesn't crash)
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return stored;
  }
}
