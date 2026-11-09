import { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { RealtimeService } from "../realtime/realtime.service";
import type { NotificationsService } from "../notifications/notifications.service";

const logger = new Logger("ConversationAssignment");

export interface AssignmentDeps {
  prisma: PrismaService;
  realtime: RealtimeService;
  notifications?: NotificationsService;
}

export interface ApplyAssignmentOpts {
  workspaceId: string;
  conversationId: string;
  /** New assignee (string), unassign (null) or leave unchanged (undefined). */
  assigneeId?: string | null;
  actorId?: string;
  /** Other columns to write in the same guarded update (ConversationsService.update). */
  extraData?: Prisma.ConversationUncheckedUpdateManyInput;
  /** Optimistic-concurrency guard: the write matches only this version. */
  enforceVersion?: number;
  /** Ownership actions never reorder the inbox (list sorts by updatedAt). */
  preserveUpdatedAt: true;
  /** The row as the caller already read it; loaded here when omitted. */
  current?: { assigneeId: string | null; updatedAt: Date; version: number };
  /** Ticket sync: skip silently unless `assigneeId` is a workspace member. */
  requireMember?: boolean;
}

/**
 * THE conversation ownership write: guarded update + version bump +
 * `inbox.activity` + SP-05 assignment notification. Used by
 * ConversationsService.update (which does its own visibility / version /
 * member checks first) and by the ticket → conversation sync
 * (Pipeline.assignsConversations; an internal sync that deliberately skips
 * viewer visibility and the optimistic version, but keeps the member check).
 *
 * Returns `count` (0 = the version guard or the row was lost) and the fresh
 * row. Emits and notifies only when count > 0.
 */
export async function applyConversationAssignment(deps: AssignmentDeps, o: ApplyAssignmentOpts) {
  const { prisma, realtime } = deps;
  const { workspaceId, conversationId } = o;

  if (o.requireMember && typeof o.assigneeId === "string") {
    const m = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId: o.assigneeId } });
    if (!m) return { count: 0, fresh: null };
  }
  const current =
    o.current ??
    (await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { assigneeId: true, updatedAt: true, version: true },
    }));
  if (!current) return { count: 0, fresh: null };

  const data: Prisma.ConversationUncheckedUpdateManyInput = { ...(o.extraData ?? {}) };
  if (o.assigneeId !== undefined) data.assigneeId = o.assigneeId;
  data.version = { increment: 1 };
  data.updatedAt = current.updatedAt;

  const res = await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      workspaceId,
      ...(o.enforceVersion !== undefined ? { version: o.enforceVersion } : {}),
    },
    data,
  });
  const fresh = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { labels: { select: { labelId: true } } },
  });
  if (!fresh || res.count === 0) return { count: res.count, fresh };

  realtime.emitToWorkspace(workspaceId, "inbox.activity", {
    channel: fresh.channel,
    conversationId: fresh.id,
  });
  if (
    typeof o.assigneeId === "string" &&
    o.assigneeId !== current.assigneeId &&
    o.assigneeId !== o.actorId
  ) {
    await notifyConversationAssignment(deps, workspaceId, fresh, o.assigneeId, o.actorId);
  }
  return { count: res.count, fresh };
}

/** Best-effort: a notification problem must never fail the assignment. */
async function notifyConversationAssignment(
  deps: AssignmentDeps,
  workspaceId: string,
  conv: { id: string; contactId: string },
  assigneeId: string,
  actorId?: string,
): Promise<void> {
  const { prisma, notifications } = deps;
  if (!notifications) return;
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: conv.contactId, workspaceId },
      select: { name: true },
    });
    const actor = actorId
      ? await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } })
      : null;
    await notifications.notify(workspaceId, [assigneeId], {
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
  } catch (err) {
    logger.warn(`assignment notification failed: ${(err as Error)?.message}`);
  }
}
