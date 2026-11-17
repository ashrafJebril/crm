import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { WorkflowDispatchService } from "../workflows/workflow-dispatch.service";
import {
  REMINDER_LOOKBACK_MIN,
  REMINDER_OFFSET_DEFAULT_MIN,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  systemKeyOf,
} from "./lifecycle-catalog";
import { appointmentPayload, reminderKey } from "./lifecycle-payload";

const MIN_MS = 60_000;

/**
 * SP-24 booking reminders (ruling 3). Every 5 minutes, for each active
 * `booking_reminder` system workflow: pending/confirmed bookings whose start
 * lies in (now + offset − 15 min, now + offset] and is still in the future
 * start one run each, straight through the dispatch (no event round trip).
 * The `LifecycleDelivery` claim (`reminder:<startAt>`) makes an
 * overlapping tick, a second instance or a replay send nothing; a reschedule
 * gets a new key, so the new time gets its own reminder. A payment-locked
 * workspace is skipped without a claim, so the next tick retries while the
 * booking is still in the window.
 */
@Injectable()
export class LifecycleReminderScheduler {
  private readonly log = new Logger(LifecycleReminderScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: WorkflowDispatchService,
    private readonly paymentLock: PaymentLockService,
  ) {}

  @Cron("*/5 * * * *")
  async run(): Promise<void> {
    try {
      await this.tick({ now: new Date() });
    } catch (e) {
      this.log.warn(`reminder tick failed: ${(e as Error).message}`);
    }
  }

  async tick(opts: { now: Date; workspaceIds?: string[] }): Promise<{ started: number }> {
    const { now } = opts;
    const workflows = await this.prisma.workflow.findMany({
      where: {
        systemKey: systemKeyOf("booking_reminder"),
        status: "active",
        ...(opts.workspaceIds ? { workspaceId: { in: opts.workspaceIds } } : {}),
      },
    });
    let started = 0;
    for (const wf of workflows) {
      try {
        if (await this.paymentLock.isLocked(wf.workspaceId)) continue;
        const raw = Number((wf.triggerConfig as { offsetMinutes?: unknown } | null)?.offsetMinutes ?? REMINDER_OFFSET_DEFAULT_MIN);
        const offset = Number.isInteger(raw) && raw >= REMINDER_OFFSET_MIN && raw <= REMINDER_OFFSET_MAX ? raw : REMINDER_OFFSET_DEFAULT_MIN;
        const windowEnd = new Date(now.getTime() + offset * MIN_MS);
        const windowStart = new Date(windowEnd.getTime() - REMINDER_LOOKBACK_MIN * MIN_MS);
        const from = windowStart > now ? windowStart : now; // never a reminder for a time already past
        const [ws, appts] = await Promise.all([
          this.prisma.workspace.findUnique({ where: { id: wf.workspaceId }, select: { timezone: true } }),
          this.prisma.appointment.findMany({
            where: { workspaceId: wf.workspaceId, status: { in: ["pending", "confirmed"] }, startAt: { gt: from, lte: windowEnd } },
            include: { contact: { select: { id: true, name: true, firstName: true, phone: true } } },
          }),
        ]);
        for (const a of appts) {
          const contact = (a as unknown as { contact?: { id: string; name: string; firstName: string | null; phone: string | null } }).contact ?? null;
          const run = await this.dispatch.startTriggeredRun(wf, appointmentPayload(a, contact, ws?.timezone, reminderKey(a.startAt)));
          if (!run) continue;
          started += 1;
          await this.markSent(wf.workspaceId, a.id, run.id);
        }
      } catch (e) {
        this.log.warn(`reminder tick ws=${wf.workspaceId} failed: ${(e as Error).message}`);
      }
    }
    return { started };
  }

  /** Ruling 3: the legacy `reminderSent` flag is set after a successful send. */
  private async markSent(workspaceId: string, appointmentId: string, runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, workspaceId }, select: { result: true } });
    const sent = Object.values((run?.result ?? {}) as Record<string, { ok?: unknown } | null>).some((x) => x?.ok === true);
    if (sent) await this.prisma.appointment.updateMany({ where: { id: appointmentId, workspaceId }, data: { reminderSent: true } });
  }
}
