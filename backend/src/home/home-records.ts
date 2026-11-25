import { Prisma } from "@prisma/client";
import { conversationScopeSql, type ConversationScope } from "../insights/insights-scope";

/**
 * The home's record re-check, in bulk: the same rules as SP-05's
 * `canOpenRecord` (the member's role grants `<resource>.view`; a conversation
 * must also be inside their conversation scope; the record belongs to this
 * workspace), applied to every row of the response at once. One statement for
 * all kinds (one UNION ALL branch per kind, ids bound as an array), never one
 * query per row. Kinds the member may not view are not queried at all: their
 * rows are dropped.
 */

export type HomeRecordKind = "conversation" | "ticket" | "booking";

export interface RecordPermissions {
  conversation: boolean;
  ticket: boolean;
  booking: boolean;
}

export type RecordIds = Record<HomeRecordKind, string[]>;

const TABLE: Record<HomeRecordKind, string> = {
  conversation: "Conversation",
  ticket: "Ticket",
  booking: "Appointment",
};

/** The re-check statement, or null when there is nothing to check. */
export function openableSql(ws: string, scope: ConversationScope, can: RecordPermissions, ids: RecordIds): Prisma.Sql | null {
  const branches: Prisma.Sql[] = [];
  for (const kind of Object.keys(TABLE) as HomeRecordKind[]) {
    const list = [...new Set(ids[kind])];
    if (!can[kind] || list.length === 0) continue;
    const alias = kind === "conversation" ? "c" : "r";
    branches.push(Prisma.sql`SELECT ${kind}::text AS "kind", ${Prisma.raw(alias)}."id"
      FROM ${Prisma.raw(`"${TABLE[kind]}"`)} ${Prisma.raw(alias)}
      WHERE ${Prisma.raw(alias)}."workspaceId" = ${ws} AND ${Prisma.raw(alias)}."id" = ANY(${list}::text[])
      ${kind === "conversation" ? conversationScopeSql(scope, "c") : Prisma.empty}`);
  }
  if (branches.length === 0) return null;
  return Prisma.sql`/* home:openable */ ${Prisma.join(branches, " UNION ALL ")}`;
}

/** Sets of openable ids per kind from the statement's rows. */
export function openableSets(rows: { kind: string; id: string }[]): Record<HomeRecordKind, Set<string>> {
  const out: Record<HomeRecordKind, Set<string>> = { conversation: new Set(), ticket: new Set(), booking: new Set() };
  for (const r of rows) if (r.kind in out) out[r.kind as HomeRecordKind].add(r.id);
  return out;
}
