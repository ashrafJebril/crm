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
import { LWebhooksController } from "./l-webhooks.controller";
import { LWebhooksService } from "./l-webhooks.service";
import { LAgentService } from "./l-agent.service";
import { LConfigController } from "./l-config.controller";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LKnowledgeService } from "./l-knowledge.service";
import { LToolsService } from "./l-tools.service";
import { LMcpService } from "./l-mcp.service";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";

@Module({
  imports: [MediaModule, RealtimeModule, TicketsModule, WorkspacesModule],
  controllers: [
    FacebookController,
    InstagramController,
    WhatsAppController,
    ZernioController,
    MetaWebhooksController,
    HjzWebhooksController,
    LWebhooksController,
    LConfigController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    ZernioService,
    ZernioClient,
    MetaWebhooksService,
    HjzWebhooksService,
    LWebhooksService,
    LAgentService,
    LJoteckClient,
    LAgentResolverService,
    LKnowledgeService,
    LToolsService,
    LMcpService,
  ],
  exports: [FacebookService, InstagramService, WhatsAppService, ZernioService],
})
export class IntegrationsModule {}
