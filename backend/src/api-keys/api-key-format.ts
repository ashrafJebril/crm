import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** `crm_<12 hex prefix>_<43 base64url secret>` (32 random bytes). */
export const API_KEY_PREFIX = "crm_";
const RE = /^crm_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface NewApiKey {
  /** The full key: returned once, never stored. */
  key: string;
  /** `crm_<12 hex>`: stored, shown in lists. */
  prefix: string;
  /** sha256 hex of the full key: what the DB holds. */
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function newApiKey(): NewApiKey {
  const prefix = `${API_KEY_PREFIX}${randomBytes(6).toString("hex")}`;
  const key = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** True for anything that looks like an API key bearer (routes tokens to
 *  the key path, never to the JWT verifier). */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** `{prefix, hash}` of a well-formed key, else null. */
export function parseApiKey(raw: string): { prefix: string; hash: string } | null {
  const m = RE.exec(raw);
  if (!m) return null;
  return { prefix: `${API_KEY_PREFIX}${m[1]}`, hash: hashApiKey(raw) };
}

/** Constant-time comparison of two hex digests of equal length. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
