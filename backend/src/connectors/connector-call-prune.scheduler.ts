import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { CONNECTOR_CALL_RETENTION_DAYS } from "./connector-catalog";

/** SP-23: connector call history is kept 90 days (daily sweep). */
@Injectable()
export class ConnectorCallPruneScheduler {
  private readonly logger = new Logger(ConnectorCallPruneScheduler.name);
  now: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(opts: { workspaceIds?: string[] } = {}): Promise<number> {
    try {
      const before = new Date(this.now().getTime() - CONNECTOR_CALL_RETENTION_DAYS * 86_400_000);
      const res = await this.prisma.connectorCall.deleteMany({
        where: { at: { lt: before }, ...(opts.workspaceIds ? { workspaceId: { in: opts.workspaceIds } } : {}) },
      });
      return res.count;
    } catch (e) {
      this.logger.warn(`connector call prune failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
