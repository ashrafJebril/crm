import { Module } from "@nestjs/common";
import { TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";
import { TicketsBulkService } from "./tickets-bulk.service";
import { PipelineAutomationService } from "./pipeline-automation.service";
import { TicketAttachmentsController } from "./ticket-attachments.controller";
import { TicketAttachmentsService } from "./ticket-attachments.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { MediaModule } from "../media/media.module";

@Module({
  // SP-09: MediaModule for ticket attachments (upload, serving, the media lock).
  imports: [RealtimeModule, NotificationsModule, MediaModule],
  controllers: [TicketsController, TicketAttachmentsController],
  providers: [TicketsService, TicketsBulkService, PipelineAutomationService, TicketAttachmentsService],
  exports: [TicketsService, PipelineAutomationService],
})
export class TicketsModule {}
