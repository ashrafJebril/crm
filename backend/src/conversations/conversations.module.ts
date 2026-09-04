import { Module } from "@nestjs/common";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { RealtimeModule } from "../realtime/realtime.module";
import { LOutboundService } from "../integrations/l-outbound.service";
import { LAgentService } from "../integrations/l-agent.service";

@Module({
  imports: [RealtimeModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, LOutboundService, LAgentService],
})
export class ConversationsModule {}
