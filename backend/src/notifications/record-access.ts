import type { PrismaService } from "../prisma/prisma.service";
import type { RecordKind } from "./notifications.dto";
import type { PermissionService } from "../permissions/permission.service";
import { visibleConversationWhere } from "../permissions/visibility";

const KIND_RESOURCE: Record<string, string> = {
  contact: "contacts",
  conversation: "conversations",
  ticket: "tickets",
  booking: "bookings",
  campaign: "campaigns",
};

/**
 * Can `userId` open the record `kind:id` in this workspace?
 *
 * The user is a member, the record exists in the workspace and, when `perm`
 * is supplied, their role grants `<resource>.view` and (for conversations)
 * their conversation visibility includes it. Gates mention notifications.
 * Without `perm` (legacy callers/tests) only membership + existence apply.
 */
export async function canOpenRecord(
  prisma: PrismaService,
  workspaceId: string,
  userId: string,
  kind: RecordKind,
  id: string,
  perm?: PermissionService,
): Promise<boolean> {
  let eff: Awaited<ReturnType<PermissionService["effective"]>> = null;
  if (perm) {
    eff = await perm.effective(workspaceId, userId);
    if (!eff) return false;
    const resource = KIND_RESOURCE[kind];
    if (!resource || !perm.can(eff, `${resource}.view`)) return false;
  } else {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { id: true },
    });
    if (!member) return false;
  }
  const where = { id, workspaceId };
  const select = { id: true };
  let row: unknown;
  switch (kind) {
    case "contact":
      row = await prisma.contact.findFirst({ where, select });
      break;
    case "conversation":
      row = await prisma.conversation.findFirst({
        where: { ...where, ...(eff ? visibleConversationWhere(eff, userId) : {}) },
        select,
      });
      break;
    case "ticket":
      row = await prisma.ticket.findFirst({ where, select });
      break;
    case "booking":
      row = await prisma.appointment.findFirst({ where, select });
      break;
    case "campaign":
      row = await prisma.campaign.findFirst({ where, select });
      break;
    default:
      return false;
  }
  return !!row;
}
