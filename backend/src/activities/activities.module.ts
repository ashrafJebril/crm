import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ActivitiesController } from "./activities.controller";
import { ActivitiesService } from "./activities.service";
import { ActivityDueScheduler } from "./activity-due.scheduler";

@Module({
  imports: [NotificationsModule],
  controllers: [ActivitiesController],
  providers: [ActivitiesService, ActivityDueScheduler],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
