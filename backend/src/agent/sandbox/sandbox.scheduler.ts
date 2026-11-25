import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { SandboxService } from "./sandbox.service";

/** SP-20: deletes "Try your agent" threads 24 h after their last turn, once a day. */
@Injectable()
export class SandboxScheduler {
  private readonly log = new Logger(SandboxScheduler.name);

  constructor(private readonly sandbox: SandboxService) {}

  @Cron("0 30 3 * * *")
  async sweep(now = new Date()): Promise<number> {
    try {
      const n = await this.sandbox.sweepExpired(now);
      if (n) this.log.log(`sandbox sweep: ${n} expired thread(s) deleted`);
      return n;
    } catch (e) {
      this.log.warn(`sandbox sweep failed: ${(e as Error)?.name ?? "error"}`);
      return 0;
    }
  }
}
