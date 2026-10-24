import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { SegmentsModule } from "../segments/segments.module";
import { HjzSyncModule } from "../hjz-sync/hjz-sync.module";

@Module({
  imports: [SegmentsModule, HjzSyncModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
