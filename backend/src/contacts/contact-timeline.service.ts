import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { canOpenRecord } from "../notifications/record-access";

export type TimelineType = "activity" | "note" | "ticket_activity" | "message";

export interface TimelineItem {
  type: TimelineType;
  at: string;
  id: string;
  data: Record<string, unknown>;
}

export interface TimelinePage {
  items: TimelineItem[];
  nextBefore?: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Cursor = `<ISO>|<type>|<id>` (the last returned item). A bare ISO date is
 *  accepted too (strictly older items only). */
function parseCursor(before?: string): { at: Date; type?: string; id?: string } | null {
  if (!before) return null;
  const [iso, type, ...rest] = before.split("|");
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return type && rest.length ? { at, type, id: rest.join("|") } : { at };
}

/** Total order: newest first, then type desc, then id desc. */
function compareItems(a: TimelineItem, b: TimelineItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.type !== b.type) return a.type < b.type ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

@Injectable()
export class ContactTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** createdAt filter for one source so the cursor pages without gaps or
   *  duplicates: rows at the cursor timestamp are included only when they sort
   *  strictly after the cursor item in (type desc, id desc) order. */
  private cursorWhere(type: TimelineType, cur: ReturnType<typeof parseCursor>): Record<string, unknown> {
    if (!cur) return {};
    if (!cur.type || !cur.id || type > cur.type) return { createdAt: { lt: cur.at } };
    if (type < cur.type) return { createdAt: { lte: cur.at } };
    return { OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] };
  }

  async timeline(
    workspaceId: string,
    contactId: string,
    viewer: Viewer | undefined,
    opts: { before?: string; limit?: number },
  ): Promise<TimelinePage> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cur = parseCursor(opts.before);

    let openable: boolean;
    if (!viewer || viewer.bypass) {
      openable = !!(await this.prisma.contact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } }));
    } else {
      openable = await canOpenRecord(this.prisma, workspaceId, viewer.userId, "contact", contactId, this.perm);
    }
    if (!openable) throw new NotFoundException("Contact not found");

    const can = async (p: string) => (this.perm ? this.perm.viewerCan(workspaceId, viewer, p) : true);
    const [canTickets, canConversations] = await Promise.all([can("tickets.view"), can("conversations.view")]);

    const scope = this.perm ? await this.perm.conversationScope(workspaceId, viewer) : {};
    const restricted = Object.keys(scope).length > 0;

    // Notes may sit on a conversation the viewer cannot see (or on an opaque
    // provider thread id): keep only contact-level notes and visible ones.
    let noteScope: Record<string, unknown> = {};
    if (!canConversations) {
      noteScope = { conversationId: null };
    } else if (restricted) {
      const visible = await this.prisma.conversation.findMany({
        where: { workspaceId, contactId, ...scope },
        select: { id: true },
      });
      noteScope = { OR: [{ conversationId: null }, { conversationId: { in: visible.map((c) => c.id) } }] };
    }

    const take = limit + 1; // one extra to know whether another page exists
    const order = [{ createdAt: "desc" as const }, { id: "desc" as const }];

    const [activities, notes, ticketActivities, messages] = await Promise.all([
      this.prisma.activity.findMany({
        where: {
          workspaceId,
          contactId,
          ...(canTickets ? {} : { ticketId: null }),
          ...this.cursorWhere("activity", cur),
        },
        orderBy: order,
        take,
      }),
      this.prisma.note.findMany({
        where: {
          AND: [
            {
              workspaceId,
              contactId,
              parentId: null,
              // Ticket-linked notes belong to the ticket: hidden without tickets.view.
              ...(canTickets ? {} : { ticketId: null }),
              ...this.cursorWhere("note", cur),
            },
            noteScope,
          ],
        },
        orderBy: order,
        take,
      }),
      canTickets
        ? this.prisma.ticketActivity.findMany({
            where: { workspaceId, ticket: { contactId, workspaceId }, ...this.cursorWhere("ticket_activity", cur) },
            orderBy: order,
            take,
            include: { ticket: { select: { id: true, number: true, title: true } } },
          })
        : Promise.resolve([]),
      canConversations
        ? this.prisma.message.findMany({
            where: {
              workspaceId,
              conversation: { contactId, workspaceId, ...scope },
              ...this.cursorWhere("message", cur),
            },
            orderBy: order,
            take,
            include: { conversation: { select: { id: true, channel: true } } },
          })
        : Promise.resolve([]),
    ]);

    const merged: TimelineItem[] = [
      ...activities.map((a) => ({ type: "activity" as const, at: a.createdAt.toISOString(), id: a.id, data: { ...a } })),
      ...notes.map((n) => ({ type: "note" as const, at: n.createdAt.toISOString(), id: n.id, data: { ...n } })),
      ...ticketActivities.map((t) => ({
        type: "ticket_activity" as const,
        at: t.createdAt.toISOString(),
        id: t.id,
        data: { ...t },
      })),
      ...messages.map(({ conversation, metaMessageId: _omit, ...m }) => ({
        type: "message" as const,
        at: m.createdAt.toISOString(),
        id: m.id,
        data: { ...m, conversationId: m.conversationId, channel: conversation?.channel ?? null },
      })),
    ].sort(compareItems);

    const items = merged.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(merged.length > limit && last ? { nextBefore: `${last.at}|${last.type}|${last.id}` } : {}),
    };
  }
}
