import { Logger } from "@nestjs/common";
import type { Channel } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { decryptSecret, encryptSecret, isTokenEncryptionEnabled } from "../common/token-crypto";
import { channelError } from "./channel-errors";

/** What `Channel.secretsEnc` holds once decrypted. */
export interface ChannelSecrets {
  accessToken?: string;
  botToken?: string;
  registrationPin?: string;
}

/** Secrets plus the provider id to address (Meta phone_number_id, bot id…). */
export interface ChannelCredentials extends ChannelSecrets {
  externalId: string | null;
}

const log = new Logger("ChannelCredentials");
let warnedPlaintext = false;

/**
 * Credentials for sending on a channel.
 *  - Integration-linked (legacy) channels: the Integration row stays the
 *    credential store, exactly as `main` uses it. Its pageId is authoritative
 *    too — `main` may have re-pointed the row since it was mirrored.
 *  - Channel-only rows: decrypt `secretsEnc`.
 * Never logs secret material, even when it cannot be parsed.
 */
export async function credentialsFor(
  prisma: PrismaService,
  channel: Pick<Channel, "id" | "externalId" | "integrationId" | "secretsEnc">,
): Promise<ChannelCredentials> {
  if (channel.integrationId) {
    const integ = await prisma.integration.findFirst({
      where: { id: channel.integrationId },
      select: { pageId: true, accessToken: true },
    });
    const out: ChannelCredentials = { externalId: integ?.pageId ?? channel.externalId ?? null };
    const token = integ?.accessToken ? decryptSecret(integ.accessToken) : null;
    if (token) out.accessToken = token;
    return out;
  }
  const out: ChannelCredentials = { externalId: channel.externalId ?? null };
  if (!channel.secretsEnc) return out;
  try {
    const parsed = JSON.parse(decryptSecret(channel.secretsEnc)) as ChannelSecrets;
    for (const k of ["accessToken", "botToken", "registrationPin"] as const) {
      if (typeof parsed?.[k] === "string" && parsed[k]) out[k] = parsed[k];
    }
  } catch {
    log.warn(`channel ${channel.id}: stored secrets are unreadable (wrong TOKEN_ENC_KEY?)`);
  }
  return out;
}

export function secretsEncryptionEnabled(): boolean {
  return isTokenEncryptionEnabled();
}

/**
 * Serialize + encrypt new channel secrets (R5). Without TOKEN_ENC_KEY:
 * production refuses (400 channels.encryption_unavailable); dev stores
 * plaintext and warns once — the warning never includes the secret.
 * Existing Integration behaviour is unchanged.
 */
export function encryptChannelSecrets(secrets: ChannelSecrets): string {
  if (!secretsEncryptionEnabled()) {
    if (process.env.NODE_ENV === "production") throw channelError("channels.encryption_unavailable");
    if (!warnedPlaintext) {
      warnedPlaintext = true;
      log.warn("TOKEN_ENC_KEY is not set: channel secrets are stored unencrypted (dev only)");
    }
  }
  return encryptSecret(JSON.stringify(secrets));
}
