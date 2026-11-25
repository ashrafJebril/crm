import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { AskAgentExecutor } from "./executors/ask-agent.executor";
import { SendWhatsappExecutor } from "./executors/send-whatsapp.executor";
import { SendWhatsappTemplateExecutor } from "./executors/send-whatsapp-template.executor";
import { UpdateDataExecutor } from "./executors/update-data.executor";
import { NotifyStaffExecutor } from "./executors/notify-staff.executor";
import { evaluateCondition, interpretYesNo } from "./workflow-condition";
import {
  AskAgentStep,
  DelayConfig,
  NotifyStaffStep,
  SendWhatsappStep,
  SendWhatsappTemplateStep,
  Step,
  StepGraph,
  StoredCursor,
  UpdateDataStep,
} from "./workflow-steps";
import { RunContext } from "./workflow-variables";

export const OPTED_OUT_REASON = "contact opted out of marketing";
/** SP-24: the recorded skip reasons of a system (lifecycle) workflow run. */
export const SYSTEM_OPTED_OUT_REASON = "opted_out";
export const WORKFLOW_INACTIVE_REASON = "workflow_inactive";

@Injectable()
export class WorkflowRunnerService {
  private readonly log = new Logger(WorkflowRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendWhatsapp: SendWhatsappExecutor,
    private readonly askAgent: AskAgentExecutor,
    private readonly updateData: UpdateDataExecutor,
    private readonly paymentLock: PaymentLockService,
    private readonly sendWhatsappTemplate: SendWhatsappTemplateExecutor,
    @Optional() private readonly notifyStaff?: NotifyStaffExecutor,
  ) {}

  /** SP-24: the run's workflow, when it is a system (lifecycle) workflow. */
  private async systemWorkflow(workflowId: string | undefined): Promise<{ status: string; systemKey: string } | null> {
    if (!workflowId) return null;
    try {
      const wf = await this.prisma.workflow?.findUnique({ where: { id: workflowId }, select: { status: true, systemKey: true } });
      return wf?.systemKey ? { status: wf.status, systemKey: wf.systemKey } : null;
    } catch {
      return null;
    }
  }

  async run(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    const graph = run.stepsSnapshot as unknown as StepGraph;
    let context = run.context as unknown as RunContext;
    const result: Record<string, unknown> = { ...(run.result as Record<string, unknown>) };
    let currentId = (run.cursor as unknown as StoredCursor).stepId;
    const workflowId = (run as { workflowId?: string }).workflowId;
    const isSystem = !!(await this.systemWorkflow(workflowId));

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

        if (step.type === "condition") {
          const passed = evaluateCondition(step.config, context);
          result[step.id] = { passed };
          currentId = (passed ? step.thenNext : step.elseNext) ?? null;
          continue;
        }

        if (step.type === "ai_condition") {
          const { answer } = await this.askAgent.execute(run.workspaceId, step.config, context);
          const passed = interpretYesNo(answer);
          // `answer === null` covers every AskAgentExecutor failure mode (unconfigured
          // integration, timeout, network error, non-2xx) — it never throws. Flag it so
          // "the AI was unreachable" is distinguishable from a genuine "no" in the
          // persisted result, without changing the branch taken.
          result[step.id] = answer === null ? { passed, aiUnavailable: true } : { passed };
          currentId = (passed ? step.thenNext : step.elseNext) ?? null;
          continue;
        }

        const isSend = step.type === "send_whatsapp" || step.type === "send_whatsapp_template";
        // SP-24 gate 6: a system workflow switched off between trigger and
        // send sends nothing (the toggle wins). Checked at every send.
        if (isSystem && (isSend || step.type === "notify_staff")) {
          const wf = await this.systemWorkflow(workflowId);
          if (!wf || wf.status !== "active") {
            result[step.id] = { skipped: true, reason: WORKFLOW_INACTIVE_REASON };
            await this.prisma.workflowRun.update({
              where: { id: runId },
              data: {
                status: "cancelled",
                completedAt: new Date(),
                context: context as unknown as Prisma.InputJsonValue,
                result: result as unknown as Prisma.InputJsonValue,
              },
            });
            return;
          }
        }
        if (isSend && (await this.sendsBlocked(run.workspaceId))) {
          // Park, do not fail: same step, same context, due now. The poller
          // skips it while the workspace is locked and resumes it afterwards.
          await this.prisma.workflowRun.update({
            where: { id: runId },
            data: {
              status: "waiting",
              cursor: { stepId: step.id } satisfies StoredCursor,
              resumeAt: new Date(),
              context: context as unknown as Prisma.InputJsonValue,
              result: result as unknown as Prisma.InputJsonValue,
            },
          });
          return;
        }

        if (step.type === "send_whatsapp_template" && (await this.contactOptedOut(run.workspaceId, context))) {
          // Templates are marketing sends: honour the contact's opt-out, record
          // why nothing went out, and carry on with the rest of the workflow.
          const skipped = { skipped: true, reason: isSystem ? SYSTEM_OPTED_OUT_REASON : OPTED_OUT_REASON };
          result[step.id] = skipped;
          context = { ...context, steps: { ...context.steps, [step.id]: skipped } };
          currentId = step.next ?? null;
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

  /**
   * Whether the run's contact opted out of marketing. The contact comes from
   * the trigger (contact, ticket or appointment payload) or, for message
   * triggers, from the trigger/ticket conversation.
   */
  private async contactOptedOut(workspaceId: string, context: RunContext): Promise<boolean> {
    const trigger = context.trigger ?? {};
    const ticket = trigger.ticket as { contactId?: string | null; conversationId?: string | null } | undefined;
    const contactId =
      (trigger.contact as { id?: string } | undefined)?.id ??
      ticket?.contactId ??
      (trigger.appointment as { contactId?: string } | undefined)?.contactId;
    const conversationId = (trigger.conversation as { id?: string } | undefined)?.id ?? ticket?.conversationId;
    const or: Prisma.ContactWhereInput[] = [];
    if (contactId) or.push({ id: contactId });
    if (conversationId) or.push({ conversations: { some: { id: conversationId } } });
    if (!or.length) return false;
    const hit = await this.prisma.contact.findFirst({
      where: { workspaceId, marketingOptOut: true, OR: or },
      select: { id: true },
    });
    return !!hit;
  }

  /** Locked, or the lookup failed: either way the message must not go out. */
  private async sendsBlocked(workspaceId: string): Promise<boolean> {
    try {
      return await this.paymentLock.isLocked(workspaceId);
    } catch (e) {
      this.log.warn(`payment lock lookup failed for ${workspaceId}: ${(e as Error).message}`);
      return true;
    }
  }

  private async executeAction(
    workspaceId: string,
    step: SendWhatsappStep | SendWhatsappTemplateStep | AskAgentStep | UpdateDataStep | NotifyStaffStep,
    context: RunContext,
  ): Promise<Record<string, unknown>> {
    switch (step.type) {
      case "send_whatsapp":
        return this.sendWhatsapp.execute(workspaceId, step.config, context);
      case "send_whatsapp_template":
        return this.sendWhatsappTemplate.execute(workspaceId, step.config, context);
      case "ask_agent":
        return this.askAgent.execute(workspaceId, step.config, context);
      case "update_data":
        return this.updateData.execute(workspaceId, step.config, context);
      case "notify_staff":
        if (!this.notifyStaff) throw new Error("notify_staff is not available");
        return this.notifyStaff.execute(workspaceId, step.config, context);
    }
  }

  private computeResumeAt(config: DelayConfig): Date {
    const msPerUnit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
    return new Date(Date.now() + config.amount * msPerUnit[config.unit]);
  }
}
