import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { ZernioController } from "./zernio.controller";
import { KapsoController } from "./kapso.controller";
import { KapsoService } from "./kapso.service";
import { ZernioService } from "./zernio.service";
import { ZernioClient } from "./zernio.client";
import { MetaWebhooksController } from "./meta-webhooks.controller";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { HjzWebhooksController } from "./hjz-webhooks.controller";
import { HjzWebhooksService } from "./hjz-webhooks.service";
import { AiBridgeService } from "./ai-bridge.service";
import { AiReplyController } from "./ai-reply.controller";
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
    KapsoController,
    MetaWebhooksController,
    HjzWebhooksController,
    // Inert until KEWY_AI_URL + KEWY_AI_WEBHOOK_SECRET are set: without them
    // AiBridgeService reports unconfigured and every signature check fails.
    AiReplyController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    ZernioService,
    KapsoService,
    ZernioClient,
    MetaWebhooksService,
    HjzWebhooksService,
    AiBridgeService,
  ],
  exports: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    ZernioService,
    // TemplatesModule talks to the WhatsApp template endpoints directly.
    ZernioClient,
    AiBridgeService,
  ],
})
export class IntegrationsModule {}
