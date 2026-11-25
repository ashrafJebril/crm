import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Channel } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { channelError } from "../channel-errors";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** True when sha256(secret) equals the stored hex hash, compared in constant
 *  time. An empty secret or a missing/malformed hash never matches. */
export function secretMatchesHash(secret: string, storedHash: string | null | undefined): boolean {
  if (!secret || !storedHash || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const got = createHash("sha256").update(secret, "utf8").digest();
  const want = Buffer.from(storedHash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The request after the guard: the verified channel rides along. */
export interface TelegramWebhookRequest {
  params: Record<string, string>;
  headers: Record<string, unknown>;
  telegramChannel?: Channel;
}

/**
 * Gate for the public `POST /webhooks/telegram/:channelId`:
 *  - the channel must exist, be a Telegram channel and not be disconnected,
 *    else 404 channels.not_found;
 *  - the `X-Telegram-Bot-Api-Secret-Token` header must hash to the stored
 *    `webhookSecretHash` (timing-safe), else 403 channels.webhook_forbidden.
 *    No stored hash fails closed.
 * Runs without a workspace context (public route), so the lookup is by id
 * across workspaces; the verified row is attached for the handler.
 */
@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TelegramWebhookRequest>();
    const id = req.params?.channelId;
    if (typeof id !== "string" || !id || id.length > 64) throw channelError("channels.not_found");
    const channel = await this.prisma.raw.channel.findFirst({
      where: { id, kind: "telegram", provider: "telegram", status: { not: "disconnected" } },
    });
    if (!channel) throw channelError("channels.not_found");
    const header = req.headers?.[TELEGRAM_SECRET_HEADER];
    if (typeof header !== "string" || !secretMatchesHash(header, channel.webhookSecretHash)) {
      throw channelError("channels.webhook_forbidden");
    }
    req.telegramChannel = channel;
    return true;
  }
}
