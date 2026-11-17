import type { Prisma } from "@prisma/client";
import type { ConversationVisibility } from "./system-roles";
import type { PermissionsJson } from "./catalog";

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

/** The member making a request. `bypass` is true for super-admin and
 *  impersonation sessions, which act without a member row and see everything
 *  (same as the permission guard). Internal callers (workflows, webhooks, the
 *  resolution sweep, the MCP server) pass no viewer at all and are unfiltered:
 *  they act as the workspace, not as a member. */
export interface Viewer {
  userId: string;
  bypass?: boolean;
  /** SP-27: an API-key request: the key's scopes as permissions. Every
   *  in-service permission check (`viewerCan`) is limited to them; conversation
   *  visibility stays the creator's. */
  limit?: PermissionsJson;
}
