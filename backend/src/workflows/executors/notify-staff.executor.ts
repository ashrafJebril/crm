import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PermissionService } from "../../permissions/permission.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { NotifyStaffConfig } from "../workflow-steps";
import { RunContext } from "../workflow-variables";

/**
 * SP-24 `notify_staff`: an in-app `lifecycle` notification about a ticket,
 * never a customer send. Recipients (`assignee` | `permitted` | `members`) are
 * intersected with the members holding `tickets.view` and, when the ticket has
 * a conversation, with those who can see that conversation (an assigned-only
 * member only for a conversation assigned to them). Review Focus 4.
 */
@Injectable()
export class NotifyStaffExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
    private readonly notifications: NotificationsService,
  ) {}

  async execute(workspaceId: string, config: NotifyStaffConfig, context: RunContext): Promise<Record<string, unknown>> {
    const ticketRef = (context.trigger?.ticket ?? null) as { id?: string } | null;
    if (!ticketRef?.id) return { skipped: true, reason: "no_ticket" };
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketRef.id, workspaceId },
      select: { id: true, number: true, title: true, ownerId: true, conversationId: true, contact: { select: { name: true } } },
    });
    if (!ticket) return { skipped: true, reason: "no_ticket" };

    const userIds = await this.recipients(workspaceId, config, ticket);
    if (userIds.length === 0) return { skipped: true, reason: "no_recipients" };
    const sent = await this.notifications.notify(workspaceId, userIds, {
      type: "lifecycle",
      title: config.messageKey,
      body: JSON.stringify({ number: ticket.number, title: ticket.title, contactName: ticket.contact?.name ?? null }),
      recordKind: "ticket",
      recordId: ticket.id,
    });
    return { ok: true, notified: sent };
  }

  /** The users to notify, after the visibility rules. */
  async recipients(
    workspaceId: string,
    config: NotifyStaffConfig,
    ticket: { ownerId: string | null; conversationId: string | null },
  ): Promise<string[]> {
    const permitted = new Set(await this.perm.membersWith(workspaceId, "tickets.view"));
    let wanted: string[];
    if (config.recipient === "members") wanted = config.userIds ?? [];
    else if (config.recipient === "assignee" && ticket.ownerId) wanted = [ticket.ownerId];
    else wanted = [...permitted]; // permitted, or assignee with no assignee
    let ids = [...new Set(wanted)].filter((u) => permitted.has(u));

    if (ticket.conversationId && ids.length) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: ticket.conversationId, workspaceId },
        select: { assigneeId: true },
      });
      const keep: string[] = [];
      for (const userId of ids) {
        const eff = await this.perm.effective(workspaceId, userId);
        if (!eff) continue;
        if (eff.conversationVisibility === "assigned" && (!conv || conv.assigneeId !== userId)) continue;
        keep.push(userId);
      }
      ids = keep;
    }
    return ids;
  }
}
