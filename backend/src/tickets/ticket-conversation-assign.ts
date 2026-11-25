import { Logger } from "@nestjs/common";
import { applyConversationAssignment, type AssignmentDeps } from "../conversations/assign-conversation";

const logger = new Logger("TicketConversationAssign");

/**
 * Pipeline.assignsConversations: when a ticket's owner is set or changed, the
 * linked conversation follows, through the one shared ownership path
 * (applyConversationAssignment). This is an internal sync, so it deliberately
 * skips viewer visibility and the optimistic version check; the assignee must
 * still be a workspace member. Opaque / non-DB conversation ids match no row
 * and are skipped. Never throws: a conversation problem must not fail the
 * ticket write.
 */
export async function assignConversationToTicketOwner(
  deps: AssignmentDeps,
  workspaceId: string,
  conversationId: string | null | undefined,
  ownerId: string,
  actorId?: string,
): Promise<void> {
  if (!conversationId) return;
  try {
    const cur = await deps.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { assigneeId: true, updatedAt: true, version: true },
    });
    if (!cur || cur.assigneeId === ownerId) return;
    await applyConversationAssignment(deps, {
      workspaceId,
      conversationId,
      assigneeId: ownerId,
      actorId,
      preserveUpdatedAt: true,
      current: cur,
      requireMember: true,
    });
  } catch (err) {
    logger.warn(`conversation assignment failed: ${(err as Error)?.message}`);
  }
}
