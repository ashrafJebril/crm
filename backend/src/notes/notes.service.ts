import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { canOpenRecord } from "../notifications/record-access";
import { excerptOf, parseMentions, renderMentions } from "./mentions";

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
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** 404 when `conversationId` is a DB conversation hidden from `viewer`.
   *  (conversationId may also be an opaque FB thread id: no row, no block.) */
  private async assertConversationVisible(
    workspaceId: string,
    conversationId: string | null | undefined,
    viewer?: Viewer,
  ) {
    if (!this.perm || !conversationId) return;
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    if (Object.keys(scope).length === 0) return;
    const [visible, exists] = await Promise.all([
      this.prisma.conversation.findFirst({ where: { id: conversationId, workspaceId, ...scope }, select: { id: true } }),
      this.prisma.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: { id: true } }),
    ]);
    if (exists && !visible) throw new NotFoundException("Conversation not found");
  }

  /** Edit/delete: only the note's author, unless the actor holds
   *  conversations.manage. Internal callers (no viewer) and bypass sessions
   *  pass. A note with no author (system) is manage-only. */
  private async assertCanChange(workspaceId: string, note: { authorUserId: string | null }, viewer?: Viewer) {
    if (!viewer || viewer.bypass) return;
    if (note.authorUserId && note.authorUserId === viewer.userId) return;
    if (this.perm && (await this.perm.viewerCan(workspaceId, viewer, "conversations.manage"))) return;
    throw new ForbiddenException("Only the author can change this note");
  }

  /** Top-level notes (newest first), each with replies (oldest first) and seenBy. */
  private async list(workspaceId: string, where: Record<string, string>, viewer?: Viewer) {
    const notes = await this.prisma.note.findMany({
      where: { workspaceId, ...where, parentId: null },
      orderBy: { createdAt: "desc" },
      include: LIST_INCLUDE,
    });
    if (!this.perm) return notes;
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    if (Object.keys(scope).length === 0) return notes;
    // Restricted viewer: keep notes with no conversation and notes on a DB
    // conversation they can see. Notes on a hidden conversation, or on an
    // opaque provider thread id (FB "t_…", IG "ig:…" — no assignee, closed to
    // assigned-only members by the provider-live ruling), are dropped.
    const ids = [...new Set(notes.map((n) => n.conversationId).filter((x): x is string => !!x))];
    if (ids.length === 0) return notes;
    const visible = await this.prisma.conversation.findMany({
      where: { id: { in: ids }, workspaceId, ...scope },
      select: { id: true },
    });
    const vis = new Set(visible.map((c) => c.id));
    return notes.filter((n) => !n.conversationId || vis.has(n.conversationId));
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
      if (await canOpenRecord(this.prisma, workspaceId, id, kind, recordId, this.perm)) toNotify.push(id);
      else warnings.push({ userId: id, reason: "no_access" });
    }
    // Deferred so callers notify only after the note write succeeded.
    const send = async () => {
      if (toNotify.length === 0) return;
      let actorName: string | undefined;
      if (authorUserId) {
        try {
          const actor = await this.prisma.user.findUnique({
            where: { id: authorUserId },
            select: { name: true },
          });
          actorName = actor?.name || undefined;
        } catch {
          /* the name is a nicety; never block the mention */
        }
      }
      await this.notifications.notify(workspaceId, toNotify, {
        type: "mention",
        title: "mention.note",
        body: JSON.stringify({
          excerpt: excerptOf(renderMentions(body)),
          ...(actorName ? { actorName } : {}),
        }),
        recordKind: kind,
        recordId,
        actorId: authorUserId ?? undefined,
      });
    };
    return { memberIds, warnings, send };
  }

  listForContact(workspaceId: string, contactId: string, viewer?: Viewer) {
    return this.list(workspaceId, { contactId }, viewer);
  }

  async listForConversation(workspaceId: string, conversationId: string, viewer?: Viewer) {
    await this.assertConversationVisible(workspaceId, conversationId, viewer);
    // Opaque provider thread ids pass the check above (no DB row); the
    // viewer filter in list() then hides them from restricted viewers.
    return this.list(workspaceId, { conversationId }, viewer);
  }

  listForTicket(workspaceId: string, ticketId: string, viewer?: Viewer) {
    return this.list(workspaceId, { ticketId }, viewer);
  }

  async get(workspaceId: string, id: string, viewer?: Viewer) {
    const row = await this.prisma.note.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Note not found");
    // A note on a hidden conversation is as hidden as the conversation.
    await this.assertConversationVisible(workspaceId, row.conversationId, viewer);
    return row;
  }

  async create(workspaceId: string, dto: CreateNoteDto, authorUserId: string | null, viewer?: Viewer) {
    await this.assertConversationVisible(workspaceId, dto.conversationId, viewer);
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
    viewer?: Viewer,
  ) {
    const existing = await this.get(workspaceId, id, viewer);
    await this.assertCanChange(workspaceId, existing, viewer);
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
  async markSeen(workspaceId: string, id: string, userId: string, viewer?: Viewer) {
    await this.get(workspaceId, id, viewer);
    await this.prisma.noteSeen.upsert({
      where: { noteId_userId: { noteId: id, userId } },
      create: { noteId: id, userId },
      update: {},
    });
    return { ok: true };
  }

  async remove(workspaceId: string, id: string, viewer?: Viewer) {
    const existing = await this.get(workspaceId, id, viewer);
    await this.assertCanChange(workspaceId, existing, viewer);
    await this.prisma.note.delete({ where: { id } });
    return { ok: true };
  }
}
