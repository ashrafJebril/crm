import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MediaModule } from "../media/media.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TemplatesModule } from "../templates/templates.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";
import { ChannelHealthController } from "./health/channel-health.controller";
import { ChannelHealthService } from "./health/channel-health.service";
import { ChannelHealthScheduler } from "./health/channel-health.scheduler";
import { HealthNotifier } from "./health/health-notifier";
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
 *  ChannelsCoreModule). SP-14: number health (live check; the Zernio
 *  client comes from IntegrationsModule, the Graph client is global), the
 *  hourly health sweep (which reconciles the default number's templates
 *  through TemplatesModule) and the downgrade notifier (NotificationsModule). */
@Module({
  imports: [ChannelsCoreModule, IntegrationsModule, MediaModule, RealtimeModule, NotificationsModule, TemplatesModule],
  controllers: [ChannelsController, TelegramController, WebchatController, WhatsappChannelsController, ChannelHealthController],
  providers: [
    ChannelsService,
    ChannelHealthService,
    ChannelHealthScheduler,
    HealthNotifier,
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
  exports: [ChannelsService, ChannelHealthService],
})
export class ChannelsModule {}
