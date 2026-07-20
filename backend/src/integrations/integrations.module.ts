import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { KapsoController } from "./kapso.controller";
import { KapsoService } from "./kapso.service";
import { ZernioController } from "./zernio.controller";
import { ZernioService } from "./zernio.service";
import { ZernioClient } from "./zernio.client";
import { MetaWebhooksController } from "./meta-webhooks.controller";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { HjzWebhooksController } from "./hjz-webhooks.controller";
import { HjzWebhooksService } from "./hjz-webhooks.service";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [MediaModule, RealtimeModule],
  // HjzWebhooksController is inert until HJZ_WEBHOOK_SECRET is set (the
  // service rejects requests without it), so it's safe to register standalone.
  controllers: [
    FacebookController,
    InstagramController,
    WhatsAppController,
    KapsoController,
    ZernioController,
    MetaWebhooksController,
    HjzWebhooksController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    KapsoService,
    ZernioService,
    ZernioClient,
    MetaWebhooksService,
    HjzWebhooksService,
  ],
  exports: [FacebookService, InstagramService, WhatsAppService, KapsoService, ZernioService],
})
export class IntegrationsModule {}
