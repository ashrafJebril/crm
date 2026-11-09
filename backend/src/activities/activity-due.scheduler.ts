import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

/** Activities more than this overdue are marked notified without a
 *  notification, so a backlog does not flood the assignee. */
export const STALE_DUE_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

/** Every minute: one activity_due notification per due, assigned, open activity. */
@Injectable()
export class ActivityDueScheduler {
  private readonly logger = new Logger(ActivityDueScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    try {
      // Backlog: mark without notifying.
      await this.prisma.activity.updateMany({
        where: {
          doneAt: null,
          notifiedAt: null,
          assigneeId: { not: null },
          dueAt: { lt: new Date(now.getTime() - STALE_DUE_MS) },
        },
        data: { notifiedAt: now },
      });
      const due = await this.prisma.activity.findMany({
        where: { doneAt: null, notifiedAt: null, assigneeId: { not: null }, dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: BATCH,
        include: { contact: { select: { name: true } } },
      });
      let sent = 0;
      for (const a of due) {
        // Claim by compare-and-set so two instances (or overlapping runs) notify once.
        // A reschedule changes dueAt, so a stale read cannot claim the re-armed row.
        const claim = await this.prisma.activity.updateMany({
          where: { id: a.id, doneAt: null, notifiedAt: null, dueAt: a.dueAt },
          data: { notifiedAt: now },
        });
        if (claim.count !== 1) continue;
        await this.notifications.notify(a.workspaceId, [a.assigneeId!], {
          type: "activity_due",
          title: "activity.due",
          body: JSON.stringify({ title: a.title, contactName: a.contact?.name ?? "" }),
          recordKind: a.ticketId ? "ticket" : "contact",
          recordId: (a.ticketId ?? a.contactId)!,
        });
        sent += 1;
      }
      return sent;
    } catch (e) {
      this.logger.error(`due sweep failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
