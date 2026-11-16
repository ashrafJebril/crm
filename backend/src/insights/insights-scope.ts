import { Prisma } from "@prisma/client";

/** A viewer's conversation scope, as `PermissionService.conversationScope`
 *  returns it: `{}` (everything), `{ assigneeId }` (assigned-only) or a
 *  closed scope (`{ id: { in: [] } }`, a non-member). */
export type ConversationScope = Prisma.ConversationWhereInput;

/**
 * The conversation scope as a raw-SQL fragment on alias `alias`
 * (`AND <alias>."assigneeId" = $1`): assigned-only members see their own;
 * anything other than "everything" or "assigned to X" matches nothing (fails
 * closed). Moved from `dashboard.module.ts` `sqlScope` (SP-11), unchanged.
 * Every conversation- or message-derived insight is computed under it, inside
 * the SQL (Review Focus 1).
 */
export function conversationScopeSql(scope: ConversationScope, alias: string): Prisma.Sql {
  if (Object.keys(scope).length === 0) return Prisma.empty;
  if (typeof scope.assigneeId === "string") {
    return Prisma.sql`AND ${Prisma.raw(alias)}."assigneeId" = ${scope.assigneeId}`;
  }
  return Prisma.sql`AND FALSE`;
}

/** Test/oracle twin of `conversationScopeSql`: may a conversation with this
 *  assignee be counted for the scope? */
export function inConversationScope(scope: ConversationScope, assigneeId: string | null): boolean {
  if (Object.keys(scope).length === 0) return true;
  if (typeof scope.assigneeId === "string") return assigneeId === scope.assigneeId;
  return false;
}
