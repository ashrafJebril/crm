import { Logger } from "@nestjs/common";
import { decryptSecret, encryptSecret, isTokenEncryptionEnabled } from "../common/token-crypto";
import { metaAdsError } from "./meta-ads-errors";

const log = new Logger("MetaAdsToken");
let warnedPlaintext = false;

/** Production refuses to store a Meta Ads token without `TOKEN_ENC_KEY` (SP-19 R5). */
export function metaAdsEncryptionAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || isTokenEncryptionEnabled();
}

/**
 * Encrypts a Meta Ads token for `tokenEnc` / `pendingTokenEnc` (the
 * `encryptChannelSecrets` pattern). Without `TOKEN_ENC_KEY`: production
 * throws 400 `meta_ads.encryption_unavailable`; dev stores plaintext and
 * warns once. The warning never includes the token.
 */
export function encryptMetaAdsToken(plain: string): string {
  if (!isTokenEncryptionEnabled()) {
    if (process.env.NODE_ENV === "production") throw metaAdsError("meta_ads.encryption_unavailable");
    if (!warnedPlaintext) {
      warnedPlaintext = true;
      log.warn("TOKEN_ENC_KEY is not set: the Meta Ads token is stored unencrypted (dev only)");
    }
  }
  return encryptSecret(plain);
}

/**
 * The stored token in clear, or null when it is missing or unreadable (a
 * still-encrypted value means the key changed; it is never sent to Meta).
 */
export function readMetaAdsToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const plain = decryptSecret(stored);
  return plain && !plain.startsWith("enc:v1:") ? plain : null;
}

/** Specs: re-arm the one-time plaintext warning. */
export function resetMetaAdsTokenWarning(): void {
  warnedPlaintext = false;
}
