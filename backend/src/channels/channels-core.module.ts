import { Global, Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";
import { ChannelResolver } from "./channel-resolver.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { InboundSinkService } from "./inbound-sink.service";

/**
 * The routing building blocks every sender/receiver needs (Zernio, Meta,
 * conversations, campaigns, workflows, and T2/T3's Telegram and web chat).
 * Global and free of IntegrationsModule, so IntegrationsModule can inject
 * the resolver while ChannelsModule imports IntegrationsModule for the
 * Zernio resync — no module cycle.
 */
@Global()
@Module({
  imports: [RealtimeModule, TicketsModule],
  providers: [ChannelResolver, ChannelTransportRegistry, InboundSinkService],
  exports: [ChannelResolver, ChannelTransportRegistry, InboundSinkService],
})
export class ChannelsCoreModule {}
