import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { WEBHOOK_RETENTION_MS } from "./webhook-events";

/** SP-27: deliveries in a final state (delivered, failed) older than 30 days
 *  are deleted daily. Pending rows (e.g. a payment-locked workspace's) stay. */
@Injectable()
export class WebhookRetentionScheduler {
  private readonly logger = new Logger(WebhookRetentionScheduler.name);
  now: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<number> {
    try {
      const res = await this.prisma.webhookDelivery.deleteMany({
        where: {
          status: { in: ["delivered", "failed"] },
          createdAt: { lt: new Date(this.now().getTime() - WEBHOOK_RETENTION_MS) },
        },
      });
      return res.count;
    } catch (e) {
      this.logger.warn(`webhook retention sweep failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
