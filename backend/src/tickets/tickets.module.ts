import { Module } from "@nestjs/common";
import { TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";
import { TicketsBulkService } from "./tickets-bulk.service";
import { PipelineAutomationService } from "./pipeline-automation.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule, NotificationsModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketsBulkService, PipelineAutomationService],
  exports: [TicketsService, PipelineAutomationService],
})
export class TicketsModule {}
