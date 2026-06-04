import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MetaWebhooksController } from "./meta-webhooks.controller";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [MediaModule, RealtimeModule],
  controllers: [
    FacebookController,
    InstagramController,
    WhatsAppController,
    MetaWebhooksController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    MetaWebhooksService,
  ],
  exports: [FacebookService, InstagramService, WhatsAppService],
})
export class IntegrationsModule {}
