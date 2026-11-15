import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { localMidnight, validTz } from "../activities/buckets";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, parseCsvList } from "./ticket-fields";
import { SLA_DUE_SOON_MS } from "./ticket-sla";

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
  /** SP-09: CSV of priorities; unknown entries are ignored. */
  priority?: string;
  /** SP-09: CSV of category keys; unknown entries are ignored. */
  category?: string;
  /** SP-09: "overdue" | "due_soon" | "none"; anything else is ignored. */
  sla?: string;
}

export const TICKET_SLA_FILTERS = ["overdue", "due_soon", "none"] as const;

export const TICKET_SORTS = ["createdAt", "updatedAt", "value", "enteredStageAt", "slaDueAt", "priority"] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];
export type SortDir = "asc" | "desc";
export const TICKET_PAGE_SIZE = 50;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar day -> [start, end) UTC instants in `tz`. */
function dayBounds(day: string, tz: string, label: string): { start: Date; end: Date } {
  const m = DAY.exec(day);
  const probe = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  // Reject impossible dates like 2026-13-45 (Date.UTC would roll them over).
  if (!m || !probe || probe.getUTCMonth() !== +m[2] - 1 || probe.getUTCDate() !== +m[3]) {
    throw new BadRequestException(`${label} must be a YYYY-MM-DD date`);
  }
  const zone = validTz(tz);
  return {
    start: localMidnight(+m[1], +m[2] - 1, +m[3], zone),
    end: localMidnight(+m[1], +m[2] - 1, +m[3] + 1, zone),
  };
}

/** The one place ticket list filters become a Prisma `where` (table + kanban). */
export function buildTicketWhere(
  workspaceId: string,
  f: TicketFilter,
  tz: string,
  now: Date = new Date(),
): Prisma.TicketWhereInput {
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
    if (/^#?\d+$/.test(q)) {
      const n = parseInt(q.replace("#", ""), 10);
      if (Number.isSafeInteger(n) && n <= 2147483647) where.OR.push({ number: n });
    }
  }

  if (f.from || f.to) {
    const range: Prisma.DateTimeFilter = {};
    if (f.from) range.gte = dayBounds(f.from, tz, "from").start;
    if (f.to) range.lt = dayBounds(f.to, tz, "to").end;
    where.createdAt = range;
  }

  // SP-09
  const priorities = parseCsvList(f.priority, TICKET_PRIORITIES);
  if (priorities) where.priority = { in: priorities };
  const categories = parseCsvList(f.category, TICKET_CATEGORIES);
  if (categories) where.category = { in: categories };
  const sla = slaWhere(f.sla, now);
  if (sla) where.AND = [sla];
  return where;
}

/**
 * SP-09 SLA filter, the list-side twin of `slaState`:
 * - overdue: slaDueAt < now and the stage is not terminal;
 * - due_soon: now <= slaDueAt <= now + 24 h and not terminal;
 * - none: no due date.
 * Unknown values give no filter.
 */
export function slaWhere(sla: string | undefined, now: Date): Prisma.TicketWhereInput | null {
  if (sla === "overdue") return { slaDueAt: { lt: now }, stage: { isTerminal: false } };
  if (sla === "due_soon") {
    return { slaDueAt: { gte: now, lte: new Date(now.getTime() + SLA_DUE_SOON_MS) }, stage: { isTerminal: false } };
  }
  if (sla === "none") return { slaDueAt: null };
  return null;
}

/** Nullable sort fields: always nulls last, in both directions. */
const NULLABLE_SORTS = new Set<TicketSort>(["value", "slaDueAt"]);

/**
 * SP-09 priority sort (by rank, not alphabetically): `desc` is urgent → low,
 * `asc` is low → urgent; a value outside the list (none are written, but a raw
 * writer could) sorts after low in `desc`. Prisma cannot order by a CASE, so
 * the service walks these buckets in order (each bucket by id), and the
 * cursor's value is the bucket index in `desc` order.
 */
export const PRIORITY_BUCKETS: Prisma.TicketWhereInput[] = [
  ...TICKET_PRIORITIES.map((p) => ({ priority: p })),
  { priority: { notIn: [...TICKET_PRIORITIES] } },
];

export function priorityBucketOf(p: string | null | undefined): number {
  const i = TICKET_PRIORITIES.indexOf(p as (typeof TICKET_PRIORITIES)[number]);
  return i >= 0 ? i : TICKET_PRIORITIES.length;
}

/** Bucket indexes in walk order for `dir`. */
export function priorityBucketOrder(dir: SortDir): number[] {
  const desc = PRIORITY_BUCKETS.map((_, i) => i);
  return dir === "desc" ? desc : desc.reverse();
}

export function ticketOrderBy(sort: TicketSort, dir: SortDir): Prisma.TicketOrderByWithRelationInput[] {
  // Within a priority bucket rows go by id; the buckets are walked by the service.
  if (sort === "priority") return [{ id: dir }];
  // Nullable fields always sort nulls last so the keyset below can rely on it.
  const primary: Prisma.TicketOrderByWithRelationInput = NULLABLE_SORTS.has(sort)
    ? { [sort]: { sort: dir, nulls: "last" } }
    : { [sort]: dir };
  return [primary, { id: dir }];
}

export interface Cursor {
  v: Date | number | null;
  id: string;
}

export function encodeCursor(
  sort: TicketSort,
  row: { id: string } & Partial<Record<TicketSort, Date | number | string | null>>,
): string {
  const raw = sort === "priority" ? priorityBucketOf(row.priority as string | null) : row[sort];
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
    if (sort === "priority") {
      if (!Number.isInteger(v) || v < 0 || v >= PRIORITY_BUCKETS.length) throw new Error("v");
      return { v, id };
    }
    if (sort === "slaDueAt" && v === null) return { v: null, id };
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
  if (sort === "priority") {
    // The service applies this inside the cursor's own bucket only.
    return { id: { [op]: c.id } };
  }
  if (NULLABLE_SORTS.has(sort)) {
    if (c.v === null) return { [sort]: null, id: { [op]: c.id } };
    return { OR: [{ [sort]: { [op]: c.v } }, { [sort]: c.v, id: { [op]: c.id } }, { [sort]: null }] };
  }
  return { OR: [{ [sort]: { [op]: c.v } }, { [sort]: c.v, id: { [op]: c.id } }] };
}
