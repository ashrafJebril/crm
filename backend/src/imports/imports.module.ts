import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { TagsModule } from "../tags/tags.module";
import { SegmentsModule } from "../segments/segments.module";
import { ContactsModule } from "../contacts/contacts.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ImportsController } from "./imports.controller";
import { ImportsService } from "./imports.service";
import { ImportRunnerService } from "./import-runner.service";
import { ImportResumeScheduler } from "./import-resume.scheduler";

@Module({
  imports: [MediaModule, TagsModule, SegmentsModule, ContactsModule, NotificationsModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportRunnerService, ImportResumeScheduler],
})
export class ImportsModule {}
