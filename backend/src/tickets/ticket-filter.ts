import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { localDayBounds } from "../activities/buckets";

/** Filters shared by the table view and the kanban (SP-08). */
export interface TicketFilter {
  pipelineId?: string;
  stageId?: string;
  contactId?: string;
  conversationId?: string;
  /** A user id, or "none" for unassigned. */
  ownerId?: string;
  status?: "open" | "won" | "lost";
  /** Title or contact name. */
  q?: string;
  /** Inclusive local days (YYYY-MM-DD) in the workspace timezone, on createdAt. */
  from?: string;
  to?: string;
}

export const TICKET_SORTS = ["createdAt", "updatedAt", "value", "enteredStageAt"] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];
export type SortDir = "asc" | "desc";
export const TICKET_PAGE_SIZE = 50;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar day -> [start, end) UTC instants in `tz`. */
function dayBounds(day: string, tz: string, label: string): { start: Date; end: Date } {
  const m = DAY.exec(day);
  const noon = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null;
  // Reject impossible dates like 2026-13-45 (Date.UTC would roll them over).
  if (!m || !noon || noon.getUTCMonth() !== +m[2] - 1 || noon.getUTCDate() !== +m[3]) {
    throw new BadRequestException(`${label} must be a YYYY-MM-DD date`);
  }
  // Noon UTC falls on the same calendar day in every real-world timezone's
  // wall clock close enough for localDayBounds to pick the intended day.
  return localDayBounds(noon, tz);
}

/** The one place ticket list filters become a Prisma `where` (table + kanban). */
export function buildTicketWhere(workspaceId: string, f: TicketFilter, tz: string): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = { workspaceId };
  if (f.pipelineId) where.pipelineId = f.pipelineId;
  if (f.stageId) where.stageId = f.stageId;
  if (f.contactId) where.contactId = f.contactId;
  if (f.conversationId) where.conversationId = f.conversationId;
  if (f.ownerId) where.ownerId = f.ownerId === "none" ? null : f.ownerId;

  if (f.status !== undefined) {
    if (f.status === "open") where.stage = { isTerminal: false };
    else if (f.status === "won") where.stage = { isTerminal: true, isWon: true };
    else if (f.status === "lost") where.stage = { isTerminal: true, isWon: false };
    else throw new BadRequestException("status must be open, won or lost");
  }

  const q = f.q?.trim();
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { contact: { name: { contains: q, mode: "insensitive" } } },
    ];
  }

  if (f.from || f.to) {
    const range: Prisma.DateTimeFilter = {};
    if (f.from) range.gte = dayBounds(f.from, tz, "from").start;
    if (f.to) range.lt = dayBounds(f.to, tz, "to").end;
    where.createdAt = range;
  }
  return where;
}

export function ticketOrderBy(sort: TicketSort, dir: SortDir): Prisma.TicketOrderByWithRelationInput[] {
  // Nullable value always sorts nulls last so the keyset below can rely on it.
  const primary: Prisma.TicketOrderByWithRelationInput =
    sort === "value" ? { value: { sort: dir, nulls: "last" } } : { [sort]: dir };
  return [primary, { id: dir }];
}

export interface Cursor {
  v: Date | number | null;
  id: string;
}

export function encodeCursor(sort: TicketSort, row: { id: string } & Partial<Record<TicketSort, Date | number | null>>): string {
  const raw = row[sort];
  const v = raw instanceof Date ? raw.toISOString() : (raw ?? null);
  return Buffer.from(JSON.stringify([v, row.id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, sort: TicketSort): Cursor {
  try {
    const [v, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof id !== "string" || !id) throw new Error("id");
    if (sort === "value") {
      if (v !== null && typeof v !== "number") throw new Error("v");
      return { v, id };
    }
    const d = new Date(v);
    if (typeof v !== "string" || Number.isNaN(d.getTime())) throw new Error("v");
    return { v: d, id };
  } catch {
    throw new BadRequestException("Invalid cursor");
  }
}

/** Rows strictly after `c` in the (sort, id) order: a stable keyset, ties broken by id. */
export function ticketCursorWhere(sort: TicketSort, dir: SortDir, c: Cursor): Prisma.TicketWhereInput {
  const op = dir === "asc" ? "gt" : "lt";
  if (sort === "value") {
    if (c.v === null) return { value: null, id: { [op]: c.id } };
    const v = c.v as number;
    return { OR: [{ value: { [op]: v } }, { value: v, id: { [op]: c.id } }, { value: null }] };
  }
  return { OR: [{ [sort]: { [op]: c.v } }, { [sort]: c.v, id: { [op]: c.id } }] };
}
