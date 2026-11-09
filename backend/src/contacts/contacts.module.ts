import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { SegmentsModule } from "../segments/segments.module";
import { ContactTimelineService } from "./contact-timeline.service";
import { CustomerThreadService } from "./customer-thread.service";
import { ContactsBulkService } from "./contacts-bulk.service";
import { ContactsExportService } from "./contacts-export.service";
import { TagsModule } from "../tags/tags.module";
import { TicketsModule } from "../tickets/tickets.module";
import { HjzSyncModule } from "../hjz-sync/hjz-sync.module";

@Module({
  imports: [SegmentsModule, HjzSyncModule, TagsModule, TicketsModule],
  controllers: [ContactsController],
  providers: [ContactsService, ContactsBulkService, ContactsExportService, ContactTimelineService, CustomerThreadService],
  exports: [ContactsService, ContactsBulkService],
})
export class ContactsModule {}
