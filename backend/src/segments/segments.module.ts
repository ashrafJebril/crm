import { Module } from "@nestjs/common";
import { SegmentsService } from "./segments.service";
import { MarketingOutboundService } from "./marketing-outbound.service";
import { SegmentsSyncScheduler } from "./segments-sync.scheduler";
import { SegmentsController } from "./segments.controller";

@Module({
  controllers: [SegmentsController],
  providers: [SegmentsService, MarketingOutboundService, SegmentsSyncScheduler],
  exports: [SegmentsService, MarketingOutboundService],
})
export class SegmentsModule {}
