import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { ImportRunnerService } from "./import-runner.service";

export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
/** An upload nobody ran within a day is abandoned: cancel it and drop the file (PII). */
export const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Re-kicks running imports whose runner died (restart or crash): heartbeat older than 2 minutes. */
@Injectable()
export class ImportResumeScheduler {
  private readonly logger = new Logger(ImportResumeScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ImportRunnerService,
    private readonly media: MediaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_HEARTBEAT_MS);
    const stale = await this.prisma.importJob.findMany({
      where: {
        status: "running",
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      select: { id: true, heartbeatAt: true },
      take: 20,
    });
    let resumed = 0;
    for (const j of stale) {
      if (this.runner.isRunning(j.id)) continue;
      // Claim by compare-and-set on the old heartbeat so two instances do not both resume it.
      const claim = await this.prisma.importJob.updateMany({
        where: { id: j.id, status: "running", heartbeatAt: j.heartbeatAt },
        data: { heartbeatAt: now },
      });
      if (claim.count !== 1) continue;
      this.logger.warn(`resuming stale import ${j.id}`);
      this.runner.kick(j.id);
      resumed += 1;
    }
    return resumed;
  }

  /** Cancels uploaded/previewed jobs older than 24 h and removes their stored file. */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepAbandoned(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ABANDONED_UPLOAD_MS);
    const old = await this.prisma.importJob.findMany({
      where: { status: { in: ["uploaded", "previewed"] }, createdAt: { lt: cutoff } },
      select: { id: true, status: true, workspaceId: true, fileMediaId: true },
      take: 50,
    });
    let cancelled = 0;
    for (const j of old) {
      // Fenced by the status we saw, so a job that just started running is left alone.
      const res = await this.prisma.importJob.updateMany({
        where: { id: j.id, status: j.status },
        data: { status: "cancelled", finishedAt: now },
      });
      if (res.count !== 1) continue;
      cancelled += 1;
      await this.media.remove(j.workspaceId, j.fileMediaId).catch((e) =>
        this.logger.warn(`abandoned import ${j.id} file cleanup failed: ${(e as Error).message}`),
      );
    }
    return cancelled;
  }
}
