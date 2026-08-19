import { Module } from "@nestjs/common";
import { TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";
import { PipelineAutomationService } from "./pipeline-automation.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [TicketsController],
  providers: [TicketsService, PipelineAutomationService],
  exports: [TicketsService, PipelineAutomationService],
})
export class TicketsModule {}
