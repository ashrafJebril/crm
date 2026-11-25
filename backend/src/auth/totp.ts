import { createHmac, timingSafeEqual } from "crypto";
import { TOTP_STEP_S, TOTP_WINDOW } from "../members/members-constants";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps) on node:crypto, with an
 * RFC 4648 base32 codec (ruling 3: no otplib). Proven against the RFC 6238
 * Appendix B vectors in totp.spec.ts.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; spaces, dashes and `=` padding are ignored. Throws on
 *  any other character. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for one counter, `digits` long, zero-padded. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_S);
}

/** The code for one step. `secret` is the raw key or its base32 form. */
export function totpAt(secret: Buffer | string, step: number, digits = 6): string {
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  return hotp(key, step, digits);
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The step a 6-digit `code` matches within ±TOTP_WINDOW of now, or null.
 * Steps at or before `lastStep` are refused (replay guard): a code is good
 * once. Every candidate is compared (timing-safe) before answering.
 */
export function verifyTotp(secret: Buffer | string, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const now = stepAt(nowMs);
  let hit: number | null = null;
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
    const step = now + w;
    const ok = sameCode(hotp(key, step), code);
    if (ok && (lastStep === null || step > lastStep) && hit === null) hit = step;
  }
  return hit;
}

/** otpauth:// URL for authenticator apps (rendered as a QR client-side). */
export function otpauthUrl(secretB32: string, account: string, issuer = "tkana"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${q.toString()}`;
}
