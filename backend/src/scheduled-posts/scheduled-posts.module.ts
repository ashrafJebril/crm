import { Module } from "@nestjs/common";
import { SocialModule } from "../social/social.module";
import { ScheduledPostsController } from "./scheduled-posts.controller";
import { ScheduledPostsService } from "./scheduled-posts.service";
import { ScheduledPostsScheduler } from "./scheduled-posts.scheduler";

@Module({
  imports: [SocialModule],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsService, ScheduledPostsScheduler],
  exports: [ScheduledPostsService],
})
export class ScheduledPostsModule {}
