import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "./workflow-events";
import { initialCursor, StepGraph } from "./workflow-steps";
import { WorkflowRunnerService } from "./workflow-runner.service";

interface DispatchableWorkflow {
  id: string;
  workspaceId: string;
  steps: unknown;
}

@Injectable()
export class WorkflowDispatchService {
  private readonly log = new Logger(WorkflowDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: WorkflowRunnerService,
  ) {}

  @OnEvent(WORKFLOW_TRIGGER_EVENT)
  async handleTrigger(evt: WorkflowTriggerEvent): Promise<void> {
    try {
      const workflows = await this.prisma.workflow.findMany({
        where: { workspaceId: evt.workspaceId, triggerType: evt.triggerType, status: "active" },
      });
      for (const wf of workflows) {
        if (!this.matchesTriggerConfig(wf, evt.payload)) continue;
        await this.startRun(wf, evt.payload, false);
      }
    } catch (e) {
      this.log.warn(
        `workflow dispatch failed trigger=${evt.triggerType} ws=${evt.workspaceId}: ${(e as Error).message}`,
      );
    }
  }

  async startRun(
    workflow: DispatchableWorkflow,
    triggerPayload: Record<string, unknown>,
    isTest: boolean,
  ): Promise<{ id: string }> {
    const graph = workflow.steps as unknown as StepGraph;
    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        status: "running",
        context: { trigger: triggerPayload, steps: {} } as unknown as Prisma.InputJsonValue,
        stepsSnapshot: workflow.steps as Prisma.InputJsonValue,
        cursor: initialCursor(graph) as unknown as Prisma.InputJsonValue,
        result: {} as unknown as Prisma.InputJsonValue,
        isTest,
      },
    });
    await this.runner.run(run.id);
    return run;
  }

  private matchesTriggerConfig(
    workflow: { triggerType: string; triggerConfig: unknown },
    payload: Record<string, unknown>,
  ): boolean {
    if (workflow.triggerType === "ticket_stage_changed") {
      const cfg = workflow.triggerConfig as { stageId?: string } | null;
      if (cfg?.stageId) {
        const ticket = payload.ticket as { stageId?: string } | undefined;
        return ticket?.stageId === cfg.stageId;
      }
    }
    return true;
  }
}
