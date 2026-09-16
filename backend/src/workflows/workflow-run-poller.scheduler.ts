import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { parseExpression } from "cron-parser";
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
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async resumeDueRuns(): Promise<void> {
    const due = await this.prisma.workflowRun.findMany({
      where: { status: "waiting", resumeAt: { lte: new Date() } },
      select: { id: true },
    });
    for (const run of due) {
      try {
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
        await this.dispatch.startRun(wf, { firedAt: lastOccurrence.toISOString() }, false);
      } catch (e) {
        this.log.warn(`schedule trigger for workflow ${wf.id} failed: ${(e as Error).message}`);
      }
    }
  }
}
