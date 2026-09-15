import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AskAgentExecutor } from "./executors/ask-agent.executor";
import { SendWhatsappExecutor } from "./executors/send-whatsapp.executor";
import { UpdateDataExecutor } from "./executors/update-data.executor";
import { evaluateCondition, interpretYesNo } from "./workflow-condition";
import {
  AskAgentStep,
  DelayConfig,
  SendWhatsappStep,
  Step,
  StepGraph,
  StoredCursor,
  UpdateDataStep,
} from "./workflow-steps";
import { RunContext } from "./workflow-variables";

@Injectable()
export class WorkflowRunnerService {
  private readonly log = new Logger(WorkflowRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendWhatsapp: SendWhatsappExecutor,
    private readonly askAgent: AskAgentExecutor,
    private readonly updateData: UpdateDataExecutor,
  ) {}

  async run(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    const graph = run.stepsSnapshot as unknown as StepGraph;
    let context = run.context as unknown as RunContext;
    const result: Record<string, unknown> = { ...(run.result as Record<string, unknown>) };
    let currentId = (run.cursor as unknown as StoredCursor).stepId;

    try {
      while (currentId) {
        const step: Step | undefined = graph.steps[currentId];
        if (!step) throw new Error(`Workflow run references unknown step id "${currentId}"`);

        if (step.type === "delay") {
          await this.prisma.workflowRun.update({
            where: { id: runId },
            data: {
              status: "waiting",
              cursor: { stepId: step.next ?? null } satisfies StoredCursor,
              resumeAt: this.computeResumeAt(step.config),
              context: context as unknown as Prisma.InputJsonValue,
              result: result as unknown as Prisma.InputJsonValue,
            },
          });
          return;
        }

        if (step.type === "condition" || step.type === "ai_condition") {
          const passed =
            step.type === "condition"
              ? evaluateCondition(step.config, context)
              : interpretYesNo((await this.askAgent.execute(run.workspaceId, step.config, context)).answer);
          result[step.id] = { passed };
          currentId = (passed ? step.thenNext : step.elseNext) ?? null;
          continue;
        }

        const output = await this.executeAction(run.workspaceId, step, context);
        result[step.id] = output;
        context = { ...context, steps: { ...context.steps, [step.id]: output } };
        currentId = step.next ?? null;
      }

      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: "completed",
          completedAt: new Date(),
          context: context as unknown as Prisma.InputJsonValue,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.log.warn(`workflow run ${runId} failed: ${(e as Error).message}`);
      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: (e as Error).message,
          completedAt: new Date(),
          context: context as unknown as Prisma.InputJsonValue,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async executeAction(
    workspaceId: string,
    step: SendWhatsappStep | AskAgentStep | UpdateDataStep,
    context: RunContext,
  ): Promise<Record<string, unknown>> {
    switch (step.type) {
      case "send_whatsapp":
        return this.sendWhatsapp.execute(workspaceId, step.config, context);
      case "ask_agent":
        return this.askAgent.execute(workspaceId, step.config, context);
      case "update_data":
        return this.updateData.execute(workspaceId, step.config, context);
    }
  }

  private computeResumeAt(config: DelayConfig): Date {
    const msPerUnit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
    return new Date(Date.now() + config.amount * msPerUnit[config.unit]);
  }
}
