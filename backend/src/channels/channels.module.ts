import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";
import { TelegramClient } from "./telegram/telegram.client";
import { TelegramController } from "./telegram/telegram.controller";
import { TelegramService } from "./telegram/telegram.service";
import { TelegramWebhookGuard } from "./telegram/telegram-webhook.guard";
import { WebchatController } from "./webchat/webchat.controller";
import { WhatsappChannelsController } from "./whatsapp/whatsapp-channels.controller";
import { WebchatService } from "./webchat/webchat.service";
import { WidgetGateway } from "./webchat/widget.gateway";
import { WidgetOriginGuard } from "./webchat/widget-origin.guard";
import { WidgetRateLimitGuard, widgetRateLimiterProvider } from "./webchat/widget-rate-limit.guard";
import { ZernioChannelTransport } from "./zernio-transport";

/** SP-19 channels hub (`/channels`), Telegram (T2) and the website chat
 *  widget (T3: loader, hosted page, visitor API, `/widget` socket
 *  namespace) and the WhatsApp add flows (T4: embedded signup, manual
 *  multi-number, landline verification; their services are in
 *  ChannelsCoreModule). */
@Module({
  imports: [ChannelsCoreModule, IntegrationsModule, MediaModule, RealtimeModule],
  controllers: [ChannelsController, TelegramController, WebchatController, WhatsappChannelsController],
  providers: [
    ChannelsService,
    TelegramClient,
    TelegramService,
    TelegramWebhookGuard,
    WebchatService,
    WidgetGateway,
    WidgetOriginGuard,
    WidgetRateLimitGuard,
    widgetRateLimiterProvider,
    ZernioChannelTransport,
  ],
  exports: [ChannelsService],
})
export class ChannelsModule {}
