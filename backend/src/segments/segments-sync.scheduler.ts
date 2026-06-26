import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { MarketingOutboundService } from "./marketing-outbound.service";

@Injectable()
export class SegmentsSyncScheduler {
  private readonly logger = new Logger(SegmentsSyncScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: MarketingOutboundService,
  ) {}

  // 04:00 every day — offset from HJZ's 03:00 schedule so the two sides
  // aren't pushing to each other simultaneously.
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async nightly() {
    if (!this.outbound.isConfigured()) {
      this.logger.debug("HJZ_OUTBOUND_URL unset — skipping nightly segment resync");
      return;
    }
    const workspaces = await this.prisma.workspace.findMany({
      where: { externalTenantId: { not: null } },
      select: { id: true, externalTenantId: true },
    });
    for (const ws of workspaces) {
      try {
        const r = await this.outbound.resyncAllToHjz(ws.id);
        this.logger.log(
          `segments resync workspace=${ws.id} tenant=${ws.externalTenantId} total=${r.total} sent=${r.sent} failed=${r.failed}`,
        );
      } catch (e: any) {
        this.logger.warn(`segments resync workspace=${ws.id} threw: ${e?.message ?? e}`);
      }
    }
  }
}
