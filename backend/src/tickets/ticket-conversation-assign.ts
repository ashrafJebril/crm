import { Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { RealtimeService } from "../realtime/realtime.service";
import type { NotificationsService } from "../notifications/notifications.service";

const logger = new Logger("TicketConversationAssign");

/**
 * Pipeline.assignsConversations: when a ticket's owner is set or changed, the
 * linked conversation follows. Mirrors ConversationsService.update's ownership
 * path (version bump, inbox.activity, SP-05 assignment notification) without
 * touching updatedAt, so the inbox order does not change.
 *
 * Opaque / non-DB conversation ids simply match no row and are skipped. Never
 * throws: a conversation problem must not fail the ticket write.
 */
export async function assignConversationToTicketOwner(
  deps: { prisma: PrismaService; realtime: RealtimeService; notifications?: NotificationsService },
  workspaceId: string,
  conversationId: string | null | undefined,
  ownerId: string,
  actorId?: string,
): Promise<void> {
  if (!conversationId) return;
  try {
    const { prisma, realtime, notifications } = deps;
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, channel: true, contactId: true, assigneeId: true, updatedAt: true },
    });
    if (!conv || conv.assigneeId === ownerId) return;
    await prisma.conversation.updateMany({
      where: { id: conv.id, workspaceId },
      data: { assigneeId: ownerId, version: { increment: 1 }, updatedAt: conv.updatedAt },
    });
    realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: conv.channel,
      conversationId: conv.id,
    });
    if (notifications && ownerId !== actorId) {
      const contact = await prisma.contact.findFirst({
        where: { id: conv.contactId, workspaceId },
        select: { name: true },
      });
      const actor = actorId
        ? await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } })
        : null;
      await notifications.notify(workspaceId, [ownerId], {
        type: "assignment",
        title: "assignment.conversation",
        body: JSON.stringify({
          contactName: contact?.name ?? "",
          ...(actor?.name ? { actorName: actor.name } : {}),
        }),
        recordKind: "conversation",
        recordId: conv.id,
        actorId,
      });
    }
  } catch (err) {
    logger.warn(`conversation assignment failed: ${(err as Error)?.message}`);
  }
}
