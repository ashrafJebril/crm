import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { RecipientTrackerService } from "../tracking/recipient-tracker.service";
import { CampaignLaunchRunner } from "./campaign-launch-runner.service";

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** A `launching` campaign whose heartbeat is older than this is resumed (env CAMPAIGN_LAUNCH_STALE_MS). */
export const CAMPAIGN_LAUNCH_STALE_MS = positiveInt(process.env.CAMPAIGN_LAUNCH_STALE_MS, 2 * 60 * 1000);
/** Finished direct campaigns are recounted this long after launch (as SP-12's sweep tail). */
export const DIRECT_RECOUNT_TAIL_MS = 72 * 3_600_000;
const BATCH = 20;

/**
 * SP-13 launch resume (the SP-03 ImportResumeScheduler pattern), every minute:
 * - claims `launching` campaigns whose heartbeat is stale, by compare-and-set
 *   on the old heartbeat (so two machines never both resume one), and kicks
 *   the runner;
 * - starts due scheduled direct campaigns (`scheduled` → `launching`).
 * Every 5 minutes it also recounts direct campaigns from their rows (they
 * have no broadcast to sweep; webhooks move the rows) and completes a
 * running one once no row is queued.
 */
@Injectable()
export class CampaignLaunchScheduler {
  private readonly log = new Logger(CampaignLaunchScheduler.name);
  private readonly tracker: RecipientTrackerService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CampaignLaunchRunner,
    @Optional() tracker?: RecipientTrackerService,
  ) {
    this.tracker = tracker ?? new RecipientTrackerService(prisma);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    let kicked = 0;
    try {
      const cutoff = new Date(now.getTime() - CAMPAIGN_LAUNCH_STALE_MS);
      const stale = (await this.prisma.campaign.findMany({
        // m5: oldest heartbeat first, and never the ids this process is running.
        where: {
          status: "launching",
          id: { notIn: this.runner.runningIds() },
          OR: [{ launchHeartbeatAt: { lt: cutoff } }, { launchHeartbeatAt: null }],
        },
        orderBy: [{ launchHeartbeatAt: "asc" }, { id: "asc" }],
        select: { id: true, launchHeartbeatAt: true },
        take: BATCH,
      })) as Array<{ id: string; launchHeartbeatAt: Date | null }>;
      for (const c of stale) {
        if (this.runner.isRunning(c.id)) continue;
        const claim = await this.prisma.campaign.updateMany({
          where: { id: c.id, status: "launching", launchHeartbeatAt: c.launchHeartbeatAt },
          data: { launchHeartbeatAt: now },
        });
        if (claim.count !== 1) continue;
        this.log.warn(`resuming stale campaign launch ${c.id}`);
        this.runner.kick(c.id);
        kicked++;
      }
      const due = (await this.prisma.campaign.findMany({
        where: { status: "scheduled", sendTransport: "direct", launchStage: "sending", scheduledAt: { lte: now } },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: BATCH,
      })) as Array<{ id: string }>;
      for (const c of due) {
        const claim = await this.prisma.campaign.updateMany({
          where: { id: c.id, status: "scheduled", sendTransport: "direct", launchStage: "sending" },
          data: { status: "launching", launchHeartbeatAt: now },
        });
        if (claim.count !== 1) continue;
        this.runner.kick(c.id);
        kicked++;
      }
    } catch (e) {
      this.log.warn(`campaign launch sweep failed: ${(e as Error).message}`);
    }
    return kicked;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recountDirect(now = new Date()): Promise<void> {
    try {
      const since = new Date(now.getTime() - DIRECT_RECOUNT_TAIL_MS);
      const list = (await this.prisma.campaign.findMany({
        where: { sendTransport: "direct", OR: [{ status: "running" }, { status: "completed", launchedAt: { gte: since } }] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, workspaceId: true, status: true },
        take: 200,
      })) as Array<{ id: string; workspaceId: string; status: string }>;
      for (const c of list) {
        try {
          await this.tracker.recountCampaign(c.id);
          if (c.status !== "running") continue;
          const queued = await this.prisma.campaignRecipient.count({ where: { workspaceId: c.workspaceId, campaignId: c.id, status: "queued" } });
          if (queued === 0) {
            await this.prisma.campaign.updateMany({ where: { id: c.id, status: "running" }, data: { status: "completed" } });
          }
        } catch (e) {
          this.log.warn(`direct campaign ${c.id} recount failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`direct campaign recount failed: ${(e as Error).message}`);
    }
  }
}
