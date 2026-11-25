import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PermissionService } from "../permissions/permission.service";
import { canOpenRecord } from "../notifications/record-access";

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
    @Optional() private readonly perm?: PermissionService,
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
        // A reschedule changes dueAt and a reassignment changes assigneeId, so a
        // stale read cannot claim the re-armed row.
        const claim = await this.prisma.activity.updateMany({
          where: { id: a.id, doneAt: null, notifiedAt: null, dueAt: a.dueAt, assigneeId: a.assigneeId },
          data: { notifiedAt: now },
        });
        if (claim.count !== 1) continue;
        try {
          const kind = a.ticketId ? "ticket" : "contact";
          const recordId = (a.ticketId ?? a.contactId)!;
          // The assignee must be able to open the record; otherwise the row
          // stays marked (no retry) and nothing is sent.
          if (!(await canOpenRecord(this.prisma, a.workspaceId, a.assigneeId!, kind, recordId, this.perm))) continue;
          await this.notifications.notify(a.workspaceId, [a.assigneeId!], {
            type: "activity_due",
            title: "activity.due",
            body: JSON.stringify({ title: a.title, contactName: a.contact?.name ?? "", kind: a.kind }),
            recordKind: kind,
            recordId,
          });
          sent += 1;
        } catch (e) {
          // Give the row back so the next sweep retries it.
          this.logger.warn(`due notify failed for ${a.id}: ${(e as Error).message}`);
          await this.prisma.activity
            .updateMany({ where: { id: a.id, notifiedAt: now }, data: { notifiedAt: null } })
            .catch(() => undefined);
        }
      }
      return sent;
    } catch (e) {
      this.logger.error(`due sweep failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
