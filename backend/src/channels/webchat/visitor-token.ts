import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireJwtSecret } from "../../common/jwt-secret";

/**
 * Web chat visitor identity (SP-19 T3).
 *
 * `visitorId` is 128 random bits, base64url (22 chars), minted by the server
 * on a visitor's first message. `visitorToken = HMAC-SHA256(secret,
 * "wv1:" + channelId + ":" + visitorId)`, base64url. The secret is the
 * existing `JWT_SECRET` (no new env var): `requireJwtSecret` already refuses
 * a missing or short secret, and the app cannot boot without it. The "wv1:"
 * prefix separates this MAC from any other use of the same secret.
 * Verification is timing-safe.
 */
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const isVisitorId = (v: unknown): v is string => typeof v === "string" && VISITOR_ID_RE.test(v);

export function visitorTokenFor(channelId: string, visitorId: string): string {
  return createHmac("sha256", requireJwtSecret()).update(`wv1:${channelId}:${visitorId}`, "utf8").digest("base64url");
}

export function mintVisitor(channelId: string): { visitorId: string; visitorToken: string } {
  const visitorId = randomBytes(16).toString("base64url");
  return { visitorId, visitorToken: visitorTokenFor(channelId, visitorId) };
}

export function verifyVisitorToken(channelId: string, visitorId: unknown, token: unknown): boolean {
  if (!isVisitorId(visitorId) || typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const want = Buffer.from(visitorTokenFor(channelId, visitorId), "base64url");
  const got = Buffer.from(token, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}
