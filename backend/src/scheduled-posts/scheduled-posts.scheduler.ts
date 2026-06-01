import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduledPostsService } from "./scheduled-posts.service";

@Injectable()
export class ScheduledPostsScheduler {
  private readonly log = new Logger(ScheduledPostsScheduler.name);
  constructor(private readonly svc: ScheduledPostsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const base =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    try {
      await this.svc.runTick(base);
    } catch (e) {
      this.log.error(`Scheduler tick failed: ${(e as Error).message}`);
    }
  }
}
