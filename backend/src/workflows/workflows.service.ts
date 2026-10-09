import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { StepGraph, validateStepGraph } from "./workflow-steps";
import { CreateWorkflowDto, TestWorkflowDto, UpdateWorkflowDto } from "./workflows.dto";

const shape = (w: {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  triggerConfig: unknown;
  steps: unknown;
  webhookSecret: string | null;
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

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: WorkflowDispatchService,
  ) {}

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
    await this.get(workspaceId, id);
    await this.prisma.workflow.delete({ where: { id } });
    return { ok: true };
  }

  async activate(workspaceId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Workflow not found");
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

  async deactivate(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    const updated = await this.prisma.workflow.update({ where: { id }, data: { status: "draft" } });
    return shape(updated);
  }

  async test(workspaceId: string, id: string, dto: TestWorkflowDto) {
    const row = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Workflow not found");
    const run = await this.dispatch.startRun(row, dto.payload ?? {}, true);
    return { runId: run.id };
  }

  async listRuns(workspaceId: string, workflowId: string) {
    await this.get(workspaceId, workflowId);
    const rows = await this.prisma.workflowRun.findMany({
      where: { workspaceId, workflowId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return rows.map(shapeRun);
  }

  async getRun(workspaceId: string, workflowId: string, runId: string) {
    const row = await this.prisma.workflowRun.findFirst({ where: { id: runId, workspaceId, workflowId } });
    if (!row) throw new NotFoundException("Workflow run not found");
    return shapeRun(row);
  }
}
