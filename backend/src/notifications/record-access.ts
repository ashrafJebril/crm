import type { PrismaService } from "../prisma/prisma.service";
import type { RecordKind } from "./notifications.dto";

/**
 * Can `userId` open the record `kind:id` in this workspace?
 *
 * Today: the user is a member of the workspace and the record exists in it.
 * This is the single hook SP-25 (record-level permissions) will tighten.
 */
export async function canOpenRecord(
  prisma: PrismaService,
  workspaceId: string,
  userId: string,
  kind: RecordKind,
  id: string,
): Promise<boolean> {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  });
  if (!member) return false;
  const where = { id, workspaceId };
  const select = { id: true };
  let row: unknown;
  switch (kind) {
    case "contact":
      row = await prisma.contact.findFirst({ where, select });
      break;
    case "conversation":
      row = await prisma.conversation.findFirst({ where, select });
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
