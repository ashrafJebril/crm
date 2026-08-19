import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { ZernioController } from "./zernio.controller";
import { ZernioService } from "./zernio.service";
import { ZernioClient } from "./zernio.client";
import { MetaWebhooksController } from "./meta-webhooks.controller";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { HjzWebhooksController } from "./hjz-webhooks.controller";
import { HjzWebhooksService } from "./hjz-webhooks.service";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";

@Module({
  imports: [MediaModule, RealtimeModule, TicketsModule],
  // HjzWebhooksController is inert until HJZ_WEBHOOK_SECRET is set (the
  // service rejects requests without it), so it's safe to register standalone.
  controllers: [
    FacebookController,
    InstagramController,
    WhatsAppController,
    ZernioController,
    MetaWebhooksController,
    HjzWebhooksController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    ZernioService,
    ZernioClient,
    MetaWebhooksService,
    HjzWebhooksService,
  ],
  exports: [FacebookService, InstagramService, WhatsAppService, ZernioService],
})
export class IntegrationsModule {}
