import { Module } from "@nestjs/common";
import { HjzClientSyncService } from "./hjz-client-sync.service";

@Module({
  providers: [HjzClientSyncService],
  exports: [HjzClientSyncService],
})
export class HjzSyncModule {}
