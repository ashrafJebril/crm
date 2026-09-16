jest.mock("cron-parser", () => ({ parseExpression: jest.fn() }));
import { parseExpression } from "cron-parser";
import { WorkflowRunPollerScheduler } from "./workflow-run-poller.scheduler";

describe("WorkflowRunPollerScheduler", () => {
  let prisma: {
    workflowRun: { findMany: jest.Mock };
    workflow: { findMany: jest.Mock; update: jest.Mock };
  };
  let runner: { run: jest.Mock };
  let dispatch: { startRun: jest.Mock };
  let scheduler: WorkflowRunPollerScheduler;

  beforeEach(() => {
    prisma = {
      workflowRun: { findMany: jest.fn().mockResolvedValue([]) },
      workflow: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    };
    runner = { run: jest.fn().mockResolvedValue(undefined) };
    dispatch = { startRun: jest.fn().mockResolvedValue({ id: "run1" }) };
    scheduler = new WorkflowRunPollerScheduler(prisma as never, runner as never, dispatch as never);
    (parseExpression as jest.Mock).mockReset();
  });

  describe("resumeDueRuns", () => {
    it("resumes every waiting run whose resumeAt has passed", async () => {
      prisma.workflowRun.findMany.mockResolvedValue([{ id: "run1" }, { id: "run2" }]);
      await scheduler.resumeDueRuns();
      expect(prisma.workflowRun.findMany).toHaveBeenCalledWith({
        where: { status: "waiting", resumeAt: { lte: expect.any(Date) } },
        select: { id: true },
      });
      expect(runner.run).toHaveBeenCalledWith("run1");
      expect(runner.run).toHaveBeenCalledWith("run2");
    });

    it("keeps resuming the rest of the batch if one run's resume throws", async () => {
      prisma.workflowRun.findMany.mockResolvedValue([{ id: "run1" }, { id: "run2" }]);
      runner.run.mockRejectedValueOnce(new Error("boom"));
      await expect(scheduler.resumeDueRuns()).resolves.toBeUndefined();
      expect(runner.run).toHaveBeenCalledWith("run2");
    });
  });

  describe("fireDueSchedules", () => {
    const workflow = (over: Record<string, unknown> = {}) => ({
      id: "wf1",
      workspaceId: "ws1",
      triggerType: "schedule",
      status: "active",
      triggerConfig: { cron: "0 9 * * *" },
      lastScheduledAt: null,
      steps: { entry: null, steps: {} },
      ...over,
    });

    it("fires when the most recent cron occurrence is newer than lastScheduledAt", async () => {
      prisma.workflow.findMany.mockResolvedValue([workflow()]);
      const occurrence = new Date("2026-09-15T09:00:00Z");
      (parseExpression as jest.Mock).mockReturnValue({ prev: () => ({ toDate: () => occurrence }) });

      await scheduler.fireDueSchedules();

      expect(prisma.workflow.update).toHaveBeenCalledWith({
        where: { id: "wf1" },
        data: { lastScheduledAt: occurrence },
      });
      expect(dispatch.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: "wf1" }),
        { firedAt: occurrence.toISOString() },
        false,
      );
    });

    it("does not re-fire an occurrence already recorded in lastScheduledAt", async () => {
      const occurrence = new Date("2026-09-15T09:00:00Z");
      prisma.workflow.findMany.mockResolvedValue([workflow({ lastScheduledAt: occurrence })]);
      (parseExpression as jest.Mock).mockReturnValue({ prev: () => ({ toDate: () => occurrence }) });

      await scheduler.fireDueSchedules();

      expect(dispatch.startRun).not.toHaveBeenCalled();
    });

    it("skips a schedule workflow with no cron in triggerConfig", async () => {
      prisma.workflow.findMany.mockResolvedValue([workflow({ triggerConfig: {} })]);
      await scheduler.fireDueSchedules();
      expect(parseExpression).not.toHaveBeenCalled();
      expect(dispatch.startRun).not.toHaveBeenCalled();
    });

    it("logs and continues when a workflow's cron expression is invalid", async () => {
      prisma.workflow.findMany.mockResolvedValue([workflow(), workflow({ id: "wf2" })]);
      (parseExpression as jest.Mock)
        .mockImplementationOnce(() => {
          throw new Error("bad cron");
        })
        .mockReturnValueOnce({ prev: () => ({ toDate: () => new Date("2026-09-15T09:00:00Z") }) });

      await expect(scheduler.fireDueSchedules()).resolves.toBeUndefined();
      expect(dispatch.startRun).toHaveBeenCalledTimes(1);
    });
  });
});
