import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { StepGraph, validateStepGraph } from "./workflow-steps";
import { CreateWorkflowDto, SYSTEM_ONLY_TRIGGER_TYPES, TestWorkflowDto, UpdateWorkflowDto } from "./workflows.dto";

/** SP-24: a user workflow never takes a system-only trigger (also checked by the DTO). */
function assertUserTrigger(triggerType: string | undefined) {
  if (triggerType && (SYSTEM_ONLY_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
    throw new BadRequestException(`triggerType "${triggerType}" is reserved for automatic messages`);
  }
}
import { lifecycleError } from "../lifecycle/lifecycle-errors";

const shape = (w: {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown;
  webhookSecret: string | null;
  systemKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: w.id,
  name: w.name,
  status: w.status,
  triggerType: w.triggerType,
  triggerConfig: w.triggerConfig,
  steps: w.steps,
  webhookSecret: w.webhookSecret,
  /** SP-24: "lifecycle.<key>" for a system workflow (managed in Automatic messages). */
  systemKey: w.systemKey ?? null,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

const shapeRun = (r: {
  id: string;
  status: string;
  context: unknown;
  stepsSnapshot: unknown;
  result: unknown;
  isTest: boolean;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
}) => ({
  id: r.id,
  status: r.status,
  context: r.context,
  stepsSnapshot: r.stepsSnapshot,
  result: r.result,
  isTest: r.isTest,
  error: r.error,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
});

/** The DB conversation a run was triggered by, if any. Shapes emitted:
 *  message_received -> trigger.conversation.id (zernio.service.ts); ticket
 *  triggers -> trigger.ticket.conversationId; a flat trigger.conversationId
 *  (webhook/test payloads) is honoured too. */
export function runConversationId(context: unknown): string | null {
  const t = (context as { trigger?: Record<string, any> } | null)?.trigger;
  if (!t || typeof t !== "object") return null;
  const id = t.conversation?.id ?? t.conversationId ?? t.ticket?.conversationId;
  return typeof id === "string" && id ? id : null;
}

/** A run with no conversation, shown to a restricted viewer: the trigger's
 *  message and the run result are stripped. */
function redactRun<R extends { context: unknown; result: unknown }>(run: R): R {
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const trigger = { ...((ctx.trigger ?? {}) as Record<string, unknown>) };
  delete trigger.message;
  return { ...run, context: { ...ctx, trigger }, result: null };
}

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: WorkflowDispatchService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /**
   * Restricted (assigned-only) viewers: runs on a conversation they cannot
   * see are dropped; runs with no conversation lose trigger.message and
   * result. Unrestricted viewers and internal callers get every run as-is.
   */
  private async scopeRuns(workspaceId: string, runs: ReturnType<typeof shapeRun>[], viewer?: Viewer) {
    if (!this.perm) return runs;
    const ids = runs.map((r) => runConversationId(r.context)).filter((x): x is string => !!x);
    const visible = await this.perm.visibleConversationIds(workspaceId, viewer, ids);
    if (!visible) return runs;
    const out: ReturnType<typeof shapeRun>[] = [];
    for (const r of runs) {
      const cid = runConversationId(r.context);
      if (!cid) out.push(redactRun(r));
      else if (visible.has(cid)) out.push(r);
    }
    return out;
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.workflow.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(shape);
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Workflow not found");
    return shape(row);
  }

  async create(workspaceId: string, dto: CreateWorkflowDto) {
    assertUserTrigger(dto.triggerType);
    let graph: StepGraph;
    try {
      graph = validateStepGraph(dto.steps ?? { entry: null, steps: {} }, { strict: false });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const row = await this.prisma.workflow.create({
      data: {
        workspaceId,
        name: dto.name,
        status: "draft",
        triggerType: dto.triggerType,
        triggerConfig: (dto.triggerConfig ?? {}) as Prisma.InputJsonValue,
        steps: graph as unknown as Prisma.InputJsonValue,
        webhookSecret: dto.triggerType === "webhook" ? crypto.randomBytes(24).toString("hex") : null,
      },
    });
    return shape(row);
  }

  async update(workspaceId: string, id: string, dto: UpdateWorkflowDto) {
    const existing = await this.get(workspaceId, id);
    // SP-24: a system workflow changes only through the lifecycle service.
    if (existing.systemKey) throw lifecycleError("workflows.system_locked");
    assertUserTrigger(dto.triggerType);
    let graph: StepGraph | undefined;
    if (dto.steps !== undefined) {
      try {
        graph = validateStepGraph(dto.steps, { strict: false });
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }

    // webhookSecret must stay in sync with triggerType: minted when switching into
    // "webhook", cleared when switching away from it, untouched otherwise.
    let webhookSecret: string | null | undefined;
    if (dto.triggerType !== undefined && dto.triggerType !== existing.triggerType) {
      if (dto.triggerType === "webhook") {
        webhookSecret = crypto.randomBytes(24).toString("hex");
      } else if (existing.triggerType === "webhook") {
        webhookSecret = null;
      }
    }

    const row = await this.prisma.workflow.update({
      where: { id },
      data: {
        name: dto.name,
        triggerType: dto.triggerType,
        triggerConfig: dto.triggerConfig as Prisma.InputJsonValue | undefined,
        steps: graph as unknown as Prisma.InputJsonValue | undefined,
        webhookSecret,
      },
    });
    return shape(row);
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    if (existing.systemKey) throw lifecycleError("workflows.system_locked");
    await this.prisma.workflow.delete({ where: { id } });
    return { ok: true };
  }

  /** `POST /workflows/:id/activate`. A system workflow is switched on only
   *  through the lifecycle API (its enable gate): 409 workflows.system_locked. */
  async activate(workspaceId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Workflow not found");
    if (row.systemKey) throw lifecycleError("workflows.system_locked");
    return this.doActivate(id, row.steps);
  }

  /** SP-24, internal (the lifecycle service, after its enable gate). */
  async activateSystem(workspaceId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row || !row.systemKey) throw new NotFoundException("Workflow not found");
    return this.doActivate(id, row.steps);
  }

  private async doActivate(id: string, steps: unknown) {
    const row = { steps };
    let graph: StepGraph;
    try {
      graph = validateStepGraph(row.steps);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    if (!graph.entry) throw new BadRequestException("Workflow has no steps to run");
    const updated = await this.prisma.workflow.update({ where: { id }, data: { status: "active" } });
    return shape(updated);
  }

  /** `POST /workflows/:id/deactivate`: user workflows only (409 for system rows). */
  async deactivate(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    if (existing.systemKey) throw lifecycleError("workflows.system_locked");
    return this.doDeactivate(workspaceId, id, null);
  }

  /** SP-24, internal (the lifecycle toggle): switch off and cancel parked runs. */
  async deactivateSystem(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    if (!existing.systemKey) throw new NotFoundException("Workflow not found");
    return this.doDeactivate(workspaceId, id, existing.systemKey);
  }

  private async doDeactivate(workspaceId: string, id: string, systemKey: string | null) {
    const existing = { systemKey };
    const updated = await this.prisma.workflow.update({ where: { id }, data: { status: "draft" } });
    // SP-24: a system workflow switched off must not send later from a run
    // parked by the payment lock.
    if (existing.systemKey) {
      await this.prisma.workflowRun.updateMany({
        where: { workspaceId, workflowId: id, status: "waiting" },
        data: { status: "cancelled", completedAt: new Date() },
      });
    }
    return shape(updated);
  }

  /**
   * SP-24, internal (the lifecycle service only): create a system workflow
   * as a draft, or rewrite its trigger, config, steps and name. Its status is
   * changed only through activate / deactivate.
   */
  async upsertSystemWorkflow(
    workspaceId: string,
    systemKey: string,
    data: { name: string; triggerType: string; triggerConfig: Record<string, unknown>; steps: unknown },
  ) {
    let graph: StepGraph;
    try {
      graph = validateStepGraph(data.steps);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const existing = await this.prisma.workflow.findFirst({ where: { workspaceId, systemKey } });
    const fields = {
      name: data.name,
      triggerType: data.triggerType,
      triggerConfig: data.triggerConfig as Prisma.InputJsonValue,
      steps: graph as unknown as Prisma.InputJsonValue,
    };
    const row = existing
      ? await this.prisma.workflow.update({ where: { id: existing.id }, data: fields })
      : await this.prisma.workflow.create({ data: { workspaceId, systemKey, status: "draft", webhookSecret: null, ...fields } });
    return shape(row);
  }

  async test(workspaceId: string, id: string, dto: TestWorkflowDto) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Workflow not found");
    // SP-24: a test run with any payload could send the real lifecycle template.
    if (row.systemKey) throw lifecycleError("workflows.system_locked");
    const run = await this.dispatch.startRun(row, dto.payload ?? {}, true);
    return { runId: run.id };
  }

  async listRuns(workspaceId: string, workflowId: string, viewer?: Viewer) {
    await this.get(workspaceId, workflowId);
    const rows = await this.prisma.workflowRun.findMany({
      where: { workspaceId, workflowId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return this.scopeRuns(workspaceId, rows.map(shapeRun), viewer);
  }

  async getRun(workspaceId: string, workflowId: string, runId: string, viewer?: Viewer) {
    const row = await this.prisma.workflowRun.findFirst({ where: { id: runId, workspaceId, workflowId } });
    if (!row) throw new NotFoundException("Workflow run not found");
    const [run] = await this.scopeRuns(workspaceId, [shapeRun(row)], viewer);
    if (!run) throw new NotFoundException("Workflow run not found");
    return run;
  }
}
