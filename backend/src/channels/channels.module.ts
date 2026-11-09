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

/** SP-19 channels hub (`/channels`) plus Telegram (T2). T3-T4 add web chat
 *  and the WhatsApp signup flows here. */
@Module({
  imports: [ChannelsCoreModule, IntegrationsModule, MediaModule, RealtimeModule],
  controllers: [ChannelsController, TelegramController],
  providers: [ChannelsService, TelegramClient, TelegramService, TelegramWebhookGuard],
  exports: [ChannelsService],
})
export class ChannelsModule {}
