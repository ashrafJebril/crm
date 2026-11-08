import { Module } from "@nestjs/common";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { LOutboundService } from "../integrations/l-outbound.service";
import { ConversationLabelsController } from "./conversation-labels.controller";
import { ConversationLabelsService } from "./conversation-labels.service";
import { LAgentService } from "../integrations/l-agent.service";

@Module({
  imports: [RealtimeModule, NotificationsModule],
  controllers: [ConversationsController, ConversationLabelsController],
  providers: [ConversationsService, ConversationLabelsService, LOutboundService, LAgentService],
})
export class ConversationsModule {}
