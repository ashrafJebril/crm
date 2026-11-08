import type { Prisma } from "@prisma/client";
import type { ConversationVisibility } from "./system-roles";

/** The single place "assigned-only" conversation visibility is turned into a
 *  Prisma filter. `null` (super-admin / impersonation, no member row) sees
 *  everything, the same as the permission bypass. */
export function visibleConversationWhere(
  eff: { conversationVisibility: ConversationVisibility | string } | null | undefined,
  userId: string,
): Prisma.ConversationWhereInput {
  if (eff && eff.conversationVisibility === "assigned") return { assigneeId: userId };
  return {};
}
