import { Module } from "@nestjs/common";
import { HjzClientSyncService } from "./hjz-client-sync.service";
import { HjzAppointmentSyncService } from "./hjz-appointment-sync.service";
import { HjzLinkController } from "./hjz-link.controller";
import { HjzLinkService } from "./hjz-link.service";

@Module({
  controllers: [HjzLinkController],
  providers: [HjzClientSyncService, HjzAppointmentSyncService, HjzLinkService],
  exports: [HjzClientSyncService, HjzAppointmentSyncService],
})
export class HjzSyncModule {}
