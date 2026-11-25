import { Global, Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";
import { ChannelResolver } from "./channel-resolver.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { InboundSinkService } from "./inbound-sink.service";
import { MetaGraphClient } from "./whatsapp/meta-graph.client";
import { EmbeddedSignupService } from "./whatsapp/embedded-signup.service";
import { LandlineService } from "./whatsapp/landline.service";
import { CampaignTrackingModule } from "../campaigns/tracking/campaign-tracking.module";
import { HealthCheckTrigger } from "./health/health-check-trigger";

/**
 * The routing building blocks every sender/receiver needs (Zernio, Meta,
 * conversations, campaigns, workflows, and T2/T3's Telegram and web chat).
 * Global and free of IntegrationsModule, so IntegrationsModule can inject
 * the resolver while ChannelsModule imports IntegrationsModule for the
 * Zernio resync — no module cycle.
 *
 * SP-19 T4: the WhatsApp signup and landline services live here too (they
 * need only Prisma, Realtime and the Graph client), so the old
 * `/integrations/whatsapp/oauth/exchange` route in IntegrationsModule can
 * delegate to the embedded signup without a cycle. LandlineService also
 * registers the `meta` transport's reconnect hook.
 *
 * SP-14: HealthCheckTrigger lets the Zernio and Meta webhooks ask for a
 * number health check; ChannelsModule's ChannelHealthService binds it.
 */
@Global()
@Module({
  imports: [RealtimeModule, TicketsModule, CampaignTrackingModule],
  providers: [
    ChannelResolver,
    ChannelTransportRegistry,
    InboundSinkService,
    MetaGraphClient,
    EmbeddedSignupService,
    LandlineService,
    HealthCheckTrigger,
  ],
  exports: [
    ChannelResolver,
    ChannelTransportRegistry,
    InboundSinkService,
    MetaGraphClient,
    EmbeddedSignupService,
    LandlineService,
    HealthCheckTrigger,
  ],
})
export class ChannelsCoreModule {}
