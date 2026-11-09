import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";

/** SP-19 channels hub (`/channels`). T2-T4 add Telegram, web chat and the
 *  WhatsApp signup flows here. */
@Module({
  imports: [ChannelsCoreModule, IntegrationsModule, RealtimeModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
