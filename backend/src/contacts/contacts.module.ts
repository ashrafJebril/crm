import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { SegmentsModule } from "../segments/segments.module";
import { ContactsBulkService } from "./contacts-bulk.service";
import { TagsModule } from "../tags/tags.module";
import { TicketsModule } from "../tickets/tickets.module";
import { HjzSyncModule } from "../hjz-sync/hjz-sync.module";

@Module({
  imports: [SegmentsModule, HjzSyncModule, TagsModule, TicketsModule],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsBulkService],
  exports: [ContactsService],
})
export class ContactsModule {}
