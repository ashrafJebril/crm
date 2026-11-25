import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/current-workspace.decorator";
import { Public } from "../../auth/public.decorator";
import { ConnectTelegramDto } from "../channels.dto";
import { TelegramService } from "./telegram.service";
import { TelegramWebhookGuard, type TelegramWebhookRequest } from "./telegram-webhook.guard";

/**
 * Telegram routes (permission-map.ts):
 *  - `POST /channels/telegram` — channels.create; returns a ChannelDto.
 *  - `POST /webhooks/telegram/:channelId` — public (@Public(), like the
 *    Zernio/WhatsApp webhooks); TelegramWebhookGuard validates the secret
 *    header. Neither reads conversation data for a member, so no viewer
 *    scoping applies. Reconnect is the generic `POST /channels/:id/reconnect`.
 */
@Controller()
export class TelegramController {
  constructor(private readonly svc: TelegramService) {}

  @Post("channels/telegram")
  connect(@CurrentWorkspace() workspaceId: string, @Body() dto: ConnectTelegramDto) {
    return this.svc.provision(workspaceId, dto);
  }

  /** Body is untyped on purpose (no DTO): the global ValidationPipe would
   *  reject Telegram's fields with forbidNonWhitelisted. */
  @Public()
  @UseGuards(TelegramWebhookGuard)
  @Post("webhooks/telegram/:channelId")
  @HttpCode(200)
  async webhook(@Req() req: TelegramWebhookRequest, @Body() body: unknown) {
    if (req.telegramChannel) await this.svc.ingestUpdate(req.telegramChannel, body);
    return { ok: true as const };
  }
}
