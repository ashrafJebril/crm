import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { parseExpression } from "cron-parser";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { WorkflowRunnerService } from "./workflow-runner.service";

@Injectable()
export class WorkflowRunPollerScheduler {
  private readonly log = new Logger(WorkflowRunPollerScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: WorkflowRunnerService,
    private readonly dispatch: WorkflowDispatchService,
    private readonly paymentLock: PaymentLockService,
  ) {}

  /** Locked or unknown (lookup failed) both mean "do not send now". */
  private async blocked(workspaceId: string): Promise<boolean> {
    try {
      return await this.paymentLock.isLocked(workspaceId);
    } catch (e) {
      this.log.warn(`payment lock lookup failed for ${workspaceId}: ${(e as Error).message}`);
      return true;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async resumeDueRuns(): Promise<void> {
    const due = await this.prisma.workflowRun.findMany({
      where: { status: "waiting", resumeAt: { lte: new Date() } },
      select: { id: true, workspaceId: true },
    });
    for (const run of due) {
      // A locked workspace's run stays "waiting" with its resumeAt in the past,
      // untouched, so it resumes on the first tick after the lock clears.
      if (await this.blocked(run.workspaceId)) continue;
      try {
        // Claim the run before dispatching it: if another poller tick already claimed
        // it (e.g. the previous run() call is still in flight past this cron cadence),
        // the conditional update matches zero rows and we skip it, avoiding a duplicate
        // resume of the same run from the same cursor.
        const claimed = await this.prisma.workflowRun.updateMany({
          where: { id: run.id, status: "waiting" },
          data: { status: "running" },
        });
        if (claimed.count === 0) continue;
        await this.runner.run(run.id);
      } catch (e) {
        this.log.warn(`resuming workflow run ${run.id} threw: ${(e as Error).message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async fireDueSchedules(): Promise<void> {
    const workflows = await this.prisma.workflow.findMany({
      where: { triggerType: "schedule", status: "active" },
    });
    const now = new Date();
    for (const wf of workflows) {
      const cfg = wf.triggerConfig as { cron?: string; timezone?: string } | null;
      if (!cfg?.cron) continue;
      try {
        const interval = parseExpression(cfg.cron, { currentDate: now, tz: cfg.timezone });
        const lastOccurrence = interval.prev().toDate();
        const lastFired = (wf.lastScheduledAt as Date | null) ?? new Date(0);
        if (lastOccurrence <= lastFired) continue;

        await this.prisma.workflow.update({
          where: { id: wf.id },
          data: { lastScheduledAt: lastOccurrence },
        });
        // Locked: the occurrence is consumed but no run starts, so a stale
        // scheduled send does not fire the moment payment clears.
        if (await this.blocked(wf.workspaceId)) continue;
        await this.dispatch.startRun(wf, { firedAt: lastOccurrence.toISOString() }, false);
      } catch (e) {
        this.log.warn(`schedule trigger for workflow ${wf.id} failed: ${(e as Error).message}`);
      }
    }
  }
}
