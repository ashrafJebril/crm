import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { UNDO_WINDOW_MS, isUndoNote, undoRefusal } from "../tickets/undo-stage";

export type ThreadEventKind =
  | "stage_changed"
  | "ticket_created"
  | "ticket_won"
  | "ticket_lost"
  | "booking_created"
  | "booking_status"
  | "activity_done";

export type ThreadItem =
  | { type: "message"; id: string; at: string; conversationId: string; channel: string | null; message: Record<string, unknown> }
  | { type: "seam"; id: string; at: string; conversationId: string; channel: string | null; startedAt: string }
  | {
      type: "event";
      id: string;
      kind: ThreadEventKind;
      at: string;
      ticketId?: string;
      appointmentId?: string;
      data: Record<string, unknown>;
      undoable?: boolean;
    };

export interface ThreadPage {
  /** Newest first; `before` pages to older items. */
  items: ThreadItem[];
  nextBefore?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TICKET_KIND: Record<string, ThreadEventKind> = {
  created: "ticket_created",
  stage_changed: "stage_changed",
  won: "ticket_won",
  lost: "ticket_lost",
};
const MOVE_KINDS = ["stage_changed", "won", "lost"];
const BOOKING_STATUS_EVENTS = ["completed", "cancelled", "no-show"];

/** Sort/cursor token per source. Events sort above messages at the same instant. */
type Token = "message" | "xactivity" | "xbooking_created" | "xbooking_status" | "xticket";

interface Entry {
  at: string;
  token: Token;
  id: string;
  item: ThreadItem;
  /** raw row, used to compute undoable / seams after the slice. */
  row: Record<string, any>;
}

/** Cursor = `<ISO>|<token>|<id>` of the last returned (non-seam) item. */
function parseCursor(before?: string): { at: Date; token?: string; id?: string } | null {
  if (!before) return null;
  const [iso, token, ...rest] = before.split("|");
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return token && rest.length ? { at, token, id: rest.join("|") } : { at };
}

/** Total order, newest first: at desc, token desc, id desc. */
function compare(a: Entry, b: Entry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.token !== b.token) return a.token < b.token ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * SP-31 customer thread: every conversation of a contact across channels
 * stitched into one chronological stream, with seams at conversation starts
 * and events (stage moves, ticket/booking/activity changes) synthesized on
 * read from existing rows. Nothing is written, so old threads get events
 * retroactively. Paging mirrors the SP-04 contact timeline.
 */
@Injectable()
export class CustomerThreadService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** createdAt-style filter for one source so the cursor pages without gaps or
   *  duplicates (rows at the cursor instant only when they sort strictly after
   *  the cursor item in (token desc, id desc) order). */
  private cursorWhere(token: Token, cur: ReturnType<typeof parseCursor>, field: string): Record<string, unknown> {
    if (!cur) return {};
    if (!cur.token || !cur.id || token > cur.token) return { [field]: { lt: cur.at } };
    if (token < cur.token) return { [field]: { lte: cur.at } };
    // Booking entries carry synthetic ids "<apptId>:created|status"; compare on the raw row id.
    const rawId = token.startsWith("xbooking") ? cur.id.replace(/:(created|status)$/, "") : cur.id;
    return { OR: [{ [field]: { lt: cur.at } }, { [field]: cur.at, id: { lt: rawId } }] };
  }

  async thread(
    workspaceId: string,
    contactId: string,
    viewer: Viewer | undefined,
    opts: { before?: string; limit?: number },
  ): Promise<ThreadPage> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cur = parseCursor(opts.before);

    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } });
    if (!contact) throw new NotFoundException("Contact not found");

    const can = async (p: string) => (this.perm ? this.perm.viewerCan(workspaceId, viewer, p) : true);
    const [canConversations, canTickets, canBookings, canManage] = await Promise.all([
      can("conversations.view"),
      can("tickets.view"),
      can("bookings.view"),
      can("tickets.manage"),
    ]);
    if (!canConversations) throw new NotFoundException("Contact not found");

    const scope = this.perm ? await this.perm.conversationScope(workspaceId, viewer) : {};
    if (Object.keys(scope).length > 0) {
      // Assigned-only viewers: the contact must have a conversation they can
      // see, otherwise the event sources below would leak its tickets/bookings.
      const visible = await this.prisma.conversation.findFirst({
        where: { workspaceId, contactId, ...scope },
        select: { id: true },
      });
      if (!visible) throw new NotFoundException("Contact not found");
    }

    const take = limit + 1; // one extra to know whether another page exists
    const desc = (field: string) => [{ [field]: "desc" as const }, { id: "desc" as const }];

    const [messages, ticketActs, apptCreated, apptStatus, activities] = await Promise.all([
      this.prisma.message.findMany({
        where: { workspaceId, conversation: { contactId, workspaceId, ...scope }, ...this.cursorWhere("message", cur, "createdAt") },
        orderBy: desc("createdAt"),
        take,
        include: { conversation: { select: { id: true, channel: true } } },
      }),
      canTickets
        ? this.prisma.ticketActivity.findMany({
            where: {
              workspaceId,
              kind: { in: Object.keys(TICKET_KIND) },
              ticket: { contactId, workspaceId },
              ...this.cursorWhere("xticket", cur, "createdAt"),
            },
            orderBy: desc("createdAt"),
            take,
            include: {
              ticket: { select: { id: true, number: true, title: true, pipelineId: true, stage: { select: { key: true } } } },
            },
          })
        : Promise.resolve([]),
      canBookings
        ? this.prisma.appointment.findMany({
            where: { workspaceId, contactId, ...this.cursorWhere("xbooking_created", cur, "createdAt") },
            orderBy: desc("createdAt"),
            take,
          })
        : Promise.resolve([]),
      canBookings
        ? this.prisma.appointment.findMany({
            where: {
              workspaceId,
              contactId,
              status: { in: BOOKING_STATUS_EVENTS },
              ...this.cursorWhere("xbooking_status", cur, "updatedAt"),
            },
            orderBy: desc("updatedAt"),
            take,
          })
        : Promise.resolve([]),
      this.prisma.activity.findMany({
        where: {
          AND: [
            {
              workspaceId,
              contactId,
              doneAt: { not: null },
              ...(canTickets ? {} : { ticketId: null }),
              ...(canBookings ? {} : { bookingId: null }),
            },
            this.cursorWhere("xactivity", cur, "doneAt"),
          ],
        },
        orderBy: desc("doneAt"),
        take,
      }),
    ]);

    // Stage labels for stage events (one lookup).
    const labels = new Map<string, { label: string; labelAr: string; lost: boolean }>();
    const pipelineIds = [...new Set(ticketActs.map((t: any) => t.ticket?.pipelineId).filter(Boolean))] as string[];
    const stageKeys = [
      ...new Set(ticketActs.flatMap((t: any) => [t.fromStage, t.toStage]).filter((k: unknown): k is string => !!k)),
    ];
    if (pipelineIds.length > 0 && stageKeys.length > 0) {
      const stages = await this.prisma.ticketStage.findMany({
        where: { workspaceId, pipelineId: { in: pipelineIds }, key: { in: stageKeys } },
      });
      for (const s of stages) labels.set(`${s.pipelineId}:${s.key}`, { label: s.label, labelAr: s.labelAr, lost: s.isTerminal && !s.isWon });
    }

    const entries: Entry[] = [
      ...messages.map(({ conversation, metaMessageId: _omit, ...m }: any): Entry => ({
        at: m.createdAt.toISOString(),
        token: "message",
        id: m.id,
        row: m,
        item: {
          type: "message",
          id: m.id,
          at: m.createdAt.toISOString(),
          conversationId: m.conversationId,
          channel: conversation?.channel ?? null,
          message: m,
        },
      })),
      ...ticketActs.map((t: any): Entry => {
        const at = t.createdAt.toISOString();
        const from = labels.get(`${t.ticket?.pipelineId}:${t.fromStage}`);
        const to = labels.get(`${t.ticket?.pipelineId}:${t.toStage}`);
        return {
          at,
          token: "xticket",
          id: t.id,
          row: { ...t, fromLost: !!from?.lost },
          item: {
            type: "event",
            id: t.id,
            kind: TICKET_KIND[t.kind],
            at,
            ticketId: t.ticketId,
            data: {
              ticketNumber: t.ticket?.number ?? null,
              ticketTitle: t.ticket?.title ?? null,
              fromStage: t.fromStage ?? null,
              toStage: t.toStage ?? null,
              fromLabel: from?.label ?? null,
              fromLabelAr: from?.labelAr ?? null,
              toLabel: to?.label ?? null,
              toLabelAr: to?.labelAr ?? null,
              byUserId: t.byUserId ?? null,
              note: isUndoNote(t.note) ? null : (t.note ?? null),
              isUndo: isUndoNote(t.note),
            },
          },
        };
      }),
      ...apptCreated.map((a: any): Entry => this.bookingEntry(a, "xbooking_created", "booking_created", a.createdAt)),
      ...apptStatus.map((a: any): Entry => this.bookingEntry(a, "xbooking_status", "booking_status", a.updatedAt)),
      ...activities.map((a: any): Entry => ({
        at: a.doneAt.toISOString(),
        token: "xactivity",
        id: a.id,
        row: a,
        item: {
          type: "event",
          id: a.id,
          kind: "activity_done",
          at: a.doneAt.toISOString(),
          ...(a.ticketId ? { ticketId: a.ticketId } : {}),
          ...(a.bookingId ? { appointmentId: a.bookingId } : {}),
          data: {
            activityKind: a.kind,
            title: a.title,
            outcome: a.outcome ?? null,
            assigneeId: a.assigneeId ?? null,
          },
        },
      })),
    ].sort(compare);

    const page = entries.slice(0, limit);
    const last = page[page.length - 1];
    const nextBefore = entries.length > limit && last ? `${last.at}|${last.token}|${last.id}` : undefined;

    await this.markUndoable(workspaceId, page, viewer, canManage);
    const items = await this.insertSeams(workspaceId, page);
    return { items, ...(nextBefore ? { nextBefore } : {}) };
  }

  private bookingEntry(a: any, token: Token, kind: ThreadEventKind, when: Date): Entry {
    const at = when.toISOString();
    return {
      at,
      token,
      id: `${a.id}:${kind === "booking_created" ? "created" : "status"}`,
      row: a,
      item: {
        type: "event",
        id: `${a.id}:${kind === "booking_created" ? "created" : "status"}`,
        kind,
        at,
        appointmentId: a.id,
        data: { service: a.service, serviceAr: a.serviceAr, status: a.status, startAt: a.startAt?.toISOString?.() ?? a.startAt ?? null },
      },
    };
  }

  /** `undoable` on a stage_changed event: it is the ticket's latest move, still
   *  inside the window, the ticket is still in its toStage, and the viewer is
   *  its author (or a tickets.manage holder). Same rule as the undo endpoint. */
  private async markUndoable(workspaceId: string, page: Entry[], viewer: Viewer | undefined, canManage: boolean) {
    const now = new Date();
    const candidates = page.filter(
      (e) => e.token === "xticket" && e.row.kind === "stage_changed" && now.getTime() - e.row.createdAt.getTime() <= UNDO_WINDOW_MS,
    );
    const latestByTicket = new Map<string, any>();
    await Promise.all(
      [...new Set(candidates.map((e) => e.row.ticketId as string))].map(async (ticketId) => {
        latestByTicket.set(
          ticketId,
          await this.prisma.ticketActivity.findFirst({
            where: { ticketId, workspaceId, kind: { in: MOVE_KINDS } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
        );
      }),
    );
    for (const e of page) {
      if (e.item.type !== "event" || e.item.kind !== "stage_changed") continue;
      const latest = latestByTicket.get(e.row.ticketId);
      e.item.undoable =
        !!latest &&
        latest.id === e.row.id &&
        undoRefusal({
          latest,
          ticketStageKey: e.row.ticket?.stage?.key ?? "",
          now,
          userId: viewer?.userId,
          canManage,
          fromStageIsLost: !!e.row.fromLost,
        }) === null;
    }
  }

  /** A seam sits right after (older than) the first message of each conversation
   *  whose first message is on this page, so each seam appears exactly once. */
  private async insertSeams(workspaceId: string, page: Entry[]): Promise<ThreadItem[]> {
    const firstByConversation = new Map<string, Entry>(); // oldest message of each conversation on the page
    for (const e of page) {
      if (e.item.type !== "message") continue;
      firstByConversation.set(e.item.conversationId, e); // page is newest-first: the last one wins
    }
    const seamAfter = new Map<string, ThreadItem>(); // message id -> seam
    await Promise.all(
      [...firstByConversation.entries()].map(async ([conversationId, entry]) => {
        const first = await this.prisma.message.findFirst({
          where: { conversationId, workspaceId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, createdAt: true },
        });
        if (first && first.id === entry.id && entry.item.type === "message") {
          seamAfter.set(entry.id, {
            type: "seam",
            id: conversationId,
            at: first.createdAt.toISOString(),
            conversationId,
            channel: entry.item.channel,
            startedAt: first.createdAt.toISOString(),
          });
        }
      }),
    );
    return page.flatMap((e) => (seamAfter.has(e.id) && e.item.type === "message" ? [e.item, seamAfter.get(e.id)!] : [e.item]));
  }
}
