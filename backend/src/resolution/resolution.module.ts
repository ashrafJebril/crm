import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";
import { ConversationResolutionService } from "./conversation-resolution.service";

@Module({
  imports: [TicketsModule, RealtimeModule],
  providers: [ConversationResolutionService],
})
export class ResolutionModule {}
