import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { localDayBounds, validTz } from "../activities/buckets";
import type { Section } from "../insights/insights.dto";
import { runSection, type SectionDb, type SectionTx } from "../insights/insights.service";
import type { ConversationScope } from "../insights/insights-scope";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { PrismaService } from "../prisma/prisma.service";
import { day1View } from "./day1-steps";
import type {
  AwaySummary,
  BookingRow,
  Day1StepKey,
  FollowUpRow,
  HomeDay,
  HomeDto,
  ListSection,
  TicketRow,
  WaitingConversationRow,
} from "./home.dto";
import { openableSets, openableSql, type HomeRecordKind } from "./home-records";
import {
  awaySql,
  day1Sql,
  dayBookingsSql,
  dayFollowUpsSql,
  dayTicketsDueSql,
  lateFollowUpsSql,
  schemaCheckSql,
  unassignedTicketsSql,
  waitingConversationsSql,
  type HomeDays,
} from "./home-sql";

/** How long the SP-09/SP-10 schema check is trusted (ruling 11). */
export const SCHEMA_CHECK_TTL_MS = 10 * 60_000;
/** "While you were away" for a member who never looked: the last 24 h. */
export const AWAY_DEFAULT_MS = 24 * 3_600_000;

export interface SchemaFlags {
  /** SP-09: Ticket.slaDueAt exists. */
  sp09: boolean;
  /** SP-10: Appointment.resourceId, StaffResource and Service exist. */
  sp10: boolean;
}

type Row = Record<string, unknown>;

/** An instant from a raw row: Date, or an ISO string (json_agg drops the
 *  zone of a `timestamp(3)`, which holds UTC). */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).toISOString();
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Today's and tomorrow's local bounds (workspace timezone). */
export function homeDays(now: Date, tz: string): HomeDays {
  const today = localDayBounds(now, tz);
  const tomorrow = localDayBounds(today.end, tz);
  return { todayStart: today.start, tomorrowStart: today.end, tomorrowEnd: tomorrow.end };
}

const followUp = (r: Row): FollowUpRow => ({
  id: String(r.id),
  title: String(r.title ?? ""),
  kind: String(r.kind ?? ""),
  dueAt: iso(r.dueAt),
  contactId: str(r.contactId),
  ticketId: str(r.ticketId),
});
const ticket = (r: Row): TicketRow => ({
  id: String(r.id),
  number: Number(r.number),
  title: String(r.title ?? ""),
  contactName: str(r.contactName),
  createdAt: iso(r.createdAt) as string,
  slaDueAt: iso(r.slaDueAt),
  priority: str(r.priority),
});
const booking = (r: Row): BookingRow => ({
  id: String(r.id),
  startAt: iso(r.startAt) as string,
  durationMin: Number(r.durationMin),
  service: String(r.service ?? ""),
  serviceAr: String(r.serviceAr ?? ""),
  status: String(r.status ?? ""),
  contactName: str(r.contactName),
});
const waiting = (r: Row): WaitingConversationRow => ({
  id: String(r.id),
  contactName: String(r.contactName ?? ""),
  channel: String(r.channel ?? ""),
  waitingSince: iso(r.waitingSince) as string,
  assigneeId: str(r.assigneeId),
  escalated: !!r.escalated,
});

const forbidden = { status: "forbidden" } as const;
const unavailable = { status: "unavailable" } as const;

/** Split "today"/"tomorrow" rows. */
function byDay<T>(s: Section<{ day: string; row: T }[]>): { today: Section<T[]>; tomorrow: Section<T[]> } {
  if (s.status !== "ok") return { today: s, tomorrow: s };
  return {
    today: { status: "ok", data: s.data.filter((x) => x.day === "today").map((x) => x.row) },
    tomorrow: { status: "ok", data: s.data.filter((x) => x.day === "tomorrow").map((x) => x.row) },
  };
}

/** List rows → `{ total, items }` (total from the window count). */
function list<T>(rows: Row[], map: (r: Row) => T): ListSection<T> {
  return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(map) };
}

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);
  private schema: { flags: SchemaFlags; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
  ) {}

  private get db(): SectionDb {
    return this.prisma as unknown as SectionDb;
  }

  /** Ruling 11: which of SP-09's and SP-10's columns exist. Cached; a failed
   *  check degrades both (never fails the home). */
  async schemaFlags(now = Date.now()): Promise<SchemaFlags> {
    if (this.schema && now - this.schema.at < SCHEMA_CHECK_TTL_MS) return this.schema.flags;
    try {
      const rows = await this.prisma.$queryRaw<{ table: string; column: string }[]>(schemaCheckSql());
      const has = (t: string, c: string) => rows.some((r) => r.table === t && r.column === c);
      const flags = {
        sp09: has("Ticket", "slaDueAt"),
        sp10: has("Appointment", "resourceId") && has("StaffResource", "userId") && has("Service", "id"),
      };
      this.schema = { flags, at: now };
      return flags;
    } catch (e) {
      this.logger.warn(`home schema check failed: ${(e as Error).message}`);
      return { sp09: false, sp10: false };
    }
  }

  /** The member's permission check; super-admin/impersonation sees all. */
  private async permissions(ws: string, viewer: Viewer): Promise<(p: string) => boolean> {
    if (viewer.bypass) return () => true;
    const eff = await this.perm.effective(ws, viewer.userId);
    return (p: string) => this.perm.can(eff, p);
  }

  /** `GET /home`: every section computed as the member. */
  async home(ws: string, viewer: Viewer, now: Date = new Date(), signal?: AbortSignal): Promise<HomeDto> {
    const me = viewer.userId;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: me, workspaceId: ws } },
      select: { homeSeenAt: true, homeDay1DismissedAt: true, workspace: { select: { timezone: true } } },
    });
    const tzRaw = member?.workspace?.timezone ?? (await this.prisma.workspace.findUnique({ where: { id: ws }, select: { timezone: true } }))?.timezone;
    const tz = validTz(tzRaw ?? "");
    const can = await this.permissions(ws, viewer);
    const scope: ConversationScope = await this.perm.conversationScope(ws, viewer);
    const schema = await this.schemaFlags(now.getTime());
    const days = homeDays(now, tz);
    const canConv = can("conversations.view");
    const canTickets = can("tickets.view");
    const canContacts = can("contacts.view");
    const canBookings = can("bookings.view");
    const since = member?.homeSeenAt ?? new Date(now.getTime() - AWAY_DEFAULT_MS);

    const sec = <T>(label: string, fn: (tx: SectionTx) => Promise<T>): Promise<Section<T>> =>
      runSection(this.db, label, fn, this.logger, { signal });
    const q = (tx: SectionTx, sql: Prisma.Sql) => tx.$queryRaw<Row[]>(sql);
    const skip = <T>(s: Section<T>) => Promise.resolve(s);

    const [waitingS, lateS, unassignedS, dayFollowS, dayBookS, dayTicketS, awayS, day1S] = await Promise.all([
      canConv ? sec("home.waiting", async (tx) => q(tx, waitingConversationsSql(ws, me, scope))) : skip<Row[]>(forbidden),
      canTickets || canContacts
        ? sec("home.lateFollowUps", async (tx) => q(tx, lateFollowUpsSql(ws, me, days, canTickets, canContacts)))
        : skip<Row[]>(forbidden),
      canTickets ? sec("home.unassignedTickets", async (tx) => q(tx, unassignedTicketsSql(ws, schema.sp09))) : skip<Row[]>(forbidden),
      canTickets || canContacts
        ? sec("home.dayFollowUps", async (tx) => q(tx, dayFollowUpsSql(ws, me, days, canTickets, canContacts)))
        : skip<Row[]>(forbidden),
      canBookings ? sec("home.dayBookings", async (tx) => q(tx, dayBookingsSql(ws, me, days, schema.sp10))) : skip<Row[]>(forbidden),
      !canTickets
        ? skip<Row[]>(forbidden)
        : schema.sp09
          ? sec("home.dayTicketsDue", async (tx) => q(tx, dayTicketsDueSql(ws, me, days)))
          : skip<Row[]>(unavailable),
      sec("home.away", async (tx) =>
        q(tx, awaySql(ws, since, now, scope, { conversations: canConv, bookings: canBookings, tickets: canTickets })),
      ),
      sec("home.day1", async (tx) => q(tx, day1Sql(ws, schema.sp10))),
    ]);

    // Re-check every record row by kind, in one statement (canOpenRecord's rules).
    const ids: Record<HomeRecordKind, string[]> = { conversation: [], ticket: [], booking: [] };
    const rowsOf = (s: Section<Row[]>) => (s.status === "ok" ? s.data : []);
    for (const r of rowsOf(waitingS)) ids.conversation.push(String(r.id));
    const awayRow = rowsOf(awayS)[0];
    const awayConvs = Array.isArray(awayRow?.rows) ? (awayRow.rows as Row[]) : [];
    for (const r of awayConvs) ids.conversation.push(String(r.id));
    for (const r of [...rowsOf(unassignedS), ...rowsOf(dayTicketS)]) ids.ticket.push(String(r.id));
    for (const r of rowsOf(dayBookS)) ids.booking.push(String(r.id));
    const check = openableSql(ws, scope, { conversation: canConv, ticket: canTickets, booking: canBookings }, ids);
    const openS: Section<Row[]> = check ? await sec("home.openable", async (tx) => q(tx, check)) : { status: "ok", data: [] };
    const open = openableSets(openS.status === "ok" ? (openS.data as { kind: string; id: string }[]) : []);
    // If the re-check itself failed, record lists fail closed.
    const gate = <T>(s: Section<T>): Section<T> => (openS.status === "ok" ? s : s.status === "ok" ? unavailable : s);
    const keep = (kind: HomeRecordKind) => (r: Row) => open[kind].has(String(r.id));

    const listSection = <T>(s: Section<Row[]>, kind: HomeRecordKind | null, map: (r: Row) => T): Section<ListSection<T>> => {
      if (s.status !== "ok") return s;
      const all = list(s.data, map);
      if (!kind) return { status: "ok", data: all };
      const kept = s.data.filter(keep(kind));
      return gate({ status: "ok", data: { total: Math.max(0, all.total - (s.data.length - kept.length)), items: kept.map(map) } });
    };
    const daySection = <T>(s: Section<Row[]>, kind: HomeRecordKind | null, map: (r: Row) => T) => {
      const g = kind ? gate(s) : s;
      if (g.status !== "ok") return byDay<T>(g);
      return byDay<T>({
        status: "ok",
        data: g.data.filter(kind ? keep(kind) : () => true).map((r) => ({ day: String(r.day), row: map(r) })),
      });
    };

    const follow = daySection(dayFollowS, null, followUp);
    const books = daySection(dayBookS, "booking", booking);
    const due = daySection(dayTicketS, "ticket", ticket);
    const today: HomeDay = { followUps: follow.today, bookings: books.today, ticketsDue: due.today };
    const tomorrow: HomeDay = { followUps: follow.tomorrow, bookings: books.tomorrow, ticketsDue: due.tomorrow };

    let away: Section<AwaySummary>;
    if (awayS.status !== "ok") away = awayS;
    else {
      const a = (awayS.data[0] ?? {}) as Row;
      const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      const convs = awayConvs.filter((r) => open.conversation.has(String(r.id)));
      away = gate({
        status: "ok",
        data: {
          since: since.toISOString(),
          aiReplies: canConv ? (n(a.aiReplies) ?? 0) : null,
          aiResolved: canConv ? (n(a.aiResolved) ?? 0) : null,
          agentBookings: canBookings ? (n(a.agentBookings) ?? 0) : null,
          autoTickets: canTickets ? (n(a.autoTickets) ?? 0) : null,
          conversations: convs.map((r) => ({ id: String(r.id), contactName: str(r.contactName), resolvedAt: iso(r.resolvedAt) as string })),
        },
      });
    }

    const done = (day1S.status === "ok" ? (day1S.data[0] ?? {}) : {}) as Partial<Record<Day1StepKey, boolean>>;
    const day1 =
      day1S.status === "ok"
        ? day1View(done, can, { dismissedAt: member?.homeDay1DismissedAt ?? null, hasServices: schema.sp10 })
        : { show: false, steps: [] };

    return {
      now: now.toISOString(),
      tz,
      needsPerson: {
        waitingConversations: listSection(waitingS, "conversation", waiting),
        lateFollowUps: listSection(lateS, null, followUp),
        unassignedTickets: listSection(unassignedS, "ticket", ticket),
      },
      today,
      tomorrow,
      away,
      day1,
    };
  }

  /** `POST /home/seen`: "while you were away" starts from now. */
  async seen(ws: string, viewer: Viewer, now: Date = new Date()): Promise<{ homeSeenAt: string | null }> {
    if (viewer.bypass) return { homeSeenAt: null };
    const res = await this.prisma.workspaceMember.updateMany({ where: { workspaceId: ws, userId: viewer.userId }, data: { homeSeenAt: now } });
    return { homeSeenAt: res.count > 0 ? now.toISOString() : null };
  }

  /** `POST /home/day1/dismiss`: hides the Day-1 home for this member. */
  async dismissDay1(ws: string, viewer: Viewer, now: Date = new Date()): Promise<{ dismissedAt: string | null }> {
    if (viewer.bypass) return { dismissedAt: null };
    const res = await this.prisma.workspaceMember.updateMany({
      where: { workspaceId: ws, userId: viewer.userId },
      data: { homeDay1DismissedAt: now },
    });
    return { dismissedAt: res.count > 0 ? now.toISOString() : null };
  }
}
