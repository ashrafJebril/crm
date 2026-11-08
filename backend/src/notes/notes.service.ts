import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { canOpenRecord } from "../notifications/record-access";
import { parseMentions, renderMentions } from "./mentions";

export type MentionWarning = { userId: string; reason: "not_a_member" | "no_access" };

const SEEN_SELECT = { select: { userId: true, seenAt: true } };
const LIST_INCLUDE = {
  seenBy: SEEN_SELECT,
  replies: {
    orderBy: { createdAt: "asc" as const },
    include: { seenBy: SEEN_SELECT },
  },
};

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Top-level notes (newest first), each with replies (oldest first) and seenBy. */
  private list(workspaceId: string, where: Record<string, string>) {
    return this.prisma.note.findMany({
      where: { workspaceId, ...where, parentId: null },
      orderBy: { createdAt: "desc" },
      include: LIST_INCLUDE,
    });
  }

  /** conversation -> ticket -> contact, each only if it really exists in the workspace
   *  (conversationId may be an opaque FB thread id, not a DB Conversation). */
  private async resolveRecord(
    workspaceId: string,
    note: { conversationId: string | null; ticketId: string | null; contactId: string },
  ): Promise<readonly ["conversation" | "ticket" | "contact", string]> {
    if (note.conversationId) {
      const c = await this.prisma.conversation.findFirst({
        where: { id: note.conversationId, workspaceId },
        select: { id: true },
      });
      if (c) return ["conversation", note.conversationId];
    }
    if (note.ticketId) {
      const t = await this.prisma.ticket.findFirst({
        where: { id: note.ticketId, workspaceId },
        select: { id: true },
      });
      if (t) return ["ticket", note.ticketId];
    }
    return ["contact", note.contactId];
  }

  /**
   * Resolve mentions in `body`: members only, each checked through
   * canOpenRecord. Notifies the members not in `alreadyMentioned` (and not the
   * author) who can open the record; the rest are reported as warnings.
   */
  private async processMentions(
    workspaceId: string,
    note: { conversationId: string | null; ticketId: string | null; contactId: string },
    body: string,
    authorUserId: string | null,
    alreadyMentioned: string[],
  ) {
    const parsed = parseMentions(body);
    const warnings: MentionWarning[] = [];
    if (parsed.length === 0) return { memberIds: [] as string[], warnings, send: async () => {} };
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: parsed } },
      select: { userId: true },
    });
    const memberSet = new Set(members.map((m) => m.userId));
    const memberIds = parsed.filter((id) => memberSet.has(id));
    for (const id of parsed) {
      if (!memberSet.has(id)) warnings.push({ userId: id, reason: "not_a_member" });
    }

    const [kind, recordId] = await this.resolveRecord(workspaceId, note);
    const toNotify: string[] = [];
    for (const id of memberIds) {
      if (id === authorUserId || alreadyMentioned.includes(id)) continue;
      if (await canOpenRecord(this.prisma, workspaceId, id, kind, recordId)) toNotify.push(id);
      else warnings.push({ userId: id, reason: "no_access" });
    }
    // Deferred so callers notify only after the note write succeeded.
    const send = async () => {
      if (toNotify.length === 0) return;
      await this.notifications.notify(workspaceId, toNotify, {
        type: "mention",
        title: "mention.note",
        body: JSON.stringify({ excerpt: renderMentions(body).slice(0, 120) }),
        recordKind: kind,
        recordId,
        actorId: authorUserId ?? undefined,
      });
    };
    return { memberIds, warnings, send };
  }

  listForContact(workspaceId: string, contactId: string) {
    return this.list(workspaceId, { contactId });
  }

  listForConversation(workspaceId: string, conversationId: string) {
    return this.list(workspaceId, { conversationId });
  }

  listForTicket(workspaceId: string, ticketId: string) {
    return this.list(workspaceId, { ticketId });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.note.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Note not found");
    return row;
  }

  async create(workspaceId: string, dto: CreateNoteDto, authorUserId: string | null) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: dto.contactId, workspaceId },
    });
    if (!contact) throw new NotFoundException("Contact not found");
    if (dto.parentId) {
      const parent = await this.prisma.note.findFirst({
        where: { id: dto.parentId, workspaceId },
      });
      if (!parent || parent.contactId !== dto.contactId || parent.parentId) {
        throw new BadRequestException("replies are one level");
      }
    }
    const conversationId = dto.conversationId ?? null;
    const ticketId = dto.ticketId ?? null;
    if (ticketId) {
      const t = await this.prisma.ticket.findFirst({
        where: { id: ticketId, workspaceId },
        select: { id: true },
      });
      if (!t) throw new NotFoundException("Ticket not found");
    }
    const { memberIds, warnings, send } = await this.processMentions(
      workspaceId,
      { conversationId, ticketId, contactId: dto.contactId },
      dto.body,
      authorUserId,
      [],
    );
    const note = await this.prisma.note.create({
      data: {
        workspaceId,
        contactId: dto.contactId,
        conversationId,
        ticketId,
        body: dto.body,
        authorUserId,
        parentId: dto.parentId ?? null,
        mentions: memberIds,
      },
    });
    await send();
    return { ...note, warnings };
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateNoteDto,
    actorUserId: string | null = null,
  ) {
    const existing = await this.get(workspaceId, id);
    const { memberIds, warnings, send } = await this.processMentions(
      workspaceId,
      existing,
      dto.body,
      actorUserId,
      existing.mentions ?? [],
    );
    const note = await this.prisma.note.update({
      where: { id },
      data: { body: dto.body, mentions: memberIds },
    });
    await send();
    return { ...note, warnings };
  }

  /** Idempotent read mark. The note is workspace-verified first (NoteSeen is unscoped). */
  async markSeen(workspaceId: string, id: string, userId: string) {
    await this.get(workspaceId, id);
    await this.prisma.noteSeen.upsert({
      where: { noteId_userId: { noteId: id, userId } },
      create: { noteId: id, userId },
      update: {},
    });
    return { ok: true };
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.note.delete({ where: { id } });
    return { ok: true };
  }
}
