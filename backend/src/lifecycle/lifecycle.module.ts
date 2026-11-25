import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { PermissionsModule } from "../permissions/permissions.module";
import { TemplatesModule } from "../templates/templates.module";
import { WorkflowsModule } from "../workflows/workflows.module";
import { LifecycleController } from "./lifecycle.controller";
import { LifecycleReminderScheduler } from "./lifecycle-reminder.scheduler";
import { LifecycleService } from "./lifecycle.service";

/** SP-24 lifecycle messages: a focused view over the system workflows. */
@Module({
  imports: [WorkflowsModule, TemplatesModule, NotificationsModule, PermissionsModule],
  controllers: [LifecycleController],
  providers: [LifecycleService, LifecycleReminderScheduler],
  exports: [LifecycleService],
})
export class LifecycleModule {}
