import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "./workflow-events";
import { initialCursor, StepGraph } from "./workflow-steps";
import { WorkflowRunnerService } from "./workflow-runner.service";

interface DispatchableWorkflow {
  id: string;
  workspaceId: string;
  steps: unknown;
  /** SP-24: set on a system (lifecycle) workflow. */
  systemKey?: string | null;
}

/** SP-24: what a lifecycle occurrence is about (from the trigger payload). */
export function occurrenceOf(payload: Record<string, unknown>): { entityKind: string; entityId: string; occurrenceKey: string } | null {
  const occurrenceKey = typeof payload.occurrenceKey === "string" ? payload.occurrenceKey : null;
  if (!occurrenceKey) return null;
  const appt = payload.appointment as { id?: string } | undefined;
  const ticket = payload.ticket as { id?: string } | undefined;
  if (appt?.id) return { entityKind: "appointment", entityId: appt.id, occurrenceKey };
  if (ticket?.id) return { entityKind: "ticket", entityId: ticket.id, occurrenceKey };
  return null;
}

@Injectable()
export class WorkflowDispatchService {
  private readonly log = new Logger(WorkflowDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: WorkflowRunnerService,
    private readonly paymentLock: PaymentLockService,
  ) {}

  @OnEvent(WORKFLOW_TRIGGER_EVENT)
  async handleTrigger(evt: WorkflowTriggerEvent): Promise<void> {
    try {
      const workflows = await this.prisma.workflow.findMany({
        where: { workspaceId: evt.workspaceId, triggerType: evt.triggerType, status: "active" },
      });
      // SP-24: one pipeline-kind lookup per event, shared by its workflows.
      let kind: Promise<string | null> | null = null;
      const pipelineKind = () => (kind ??= this.pipelineKindOf(evt.workspaceId, evt.payload));
      for (const wf of workflows) {
        if (!this.matchesTriggerConfig(wf, evt.payload)) continue;
        const wantKind = (wf.triggerConfig as { pipelineKind?: unknown } | null)?.pipelineKind;
        if (typeof wantKind === "string" && wantKind && (await pipelineKind()) !== wantKind) continue;
        await this.startTriggeredRun(wf, evt.payload);
      }
    } catch (e) {
      this.log.warn(
        `workflow dispatch failed trigger=${evt.triggerType} ws=${evt.workspaceId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Start a run for a real trigger (event, webhook). A locked workspace gets
   * no run at all (null), so nothing parks to send on unlock. A failed lock
   * lookup rejects: fail closed.
   */
  async startTriggeredRun(
    workflow: DispatchableWorkflow,
    triggerPayload: Record<string, unknown>,
  ): Promise<{ id: string } | null> {
    if (await this.paymentLock.isLocked(workflow.workspaceId)) return null;
    // SP-24: a system workflow runs at most once per occurrence (a replayed
    // event, two app instances, overlapping scheduler ticks). The claim is
    // kept whatever the run does (ruling 7).
    const occ = workflow.systemKey ? occurrenceOf(triggerPayload) : null;
    if (occ) {
      const { count } = await this.prisma.lifecycleDelivery.createMany({
        data: [{ workspaceId: workflow.workspaceId, workflowId: workflow.id, ...occ }],
        skipDuplicates: true,
      });
      if (count === 0) return null;
    }
    const run = await this.startRun(workflow, triggerPayload, false);
    if (occ) {
      await this.prisma.lifecycleDelivery
        .updateMany({
          where: { workflowId: workflow.id, entityId: occ.entityId, occurrenceKey: occ.occurrenceKey },
          data: { runId: run.id },
        })
        .catch(() => undefined);
    }
    return run;
  }

  /** The pipeline kind of a ticket trigger (payload first, else one lookup). */
  private async pipelineKindOf(workspaceId: string, payload: Record<string, unknown>): Promise<string | null> {
    if (typeof payload.pipelineKind === "string") return payload.pipelineKind;
    const pipelineId = (payload.ticket as { pipelineId?: string } | undefined)?.pipelineId;
    if (!pipelineId) return null;
    const p = await this.prisma.pipeline.findFirst({ where: { id: pipelineId, workspaceId }, select: { kind: true } });
    return p?.kind ?? null;
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
