import { HttpException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService, lockMediaForReference } from "../media/media.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { TICKET_ATTACHMENTS_MAX } from "./ticket-fields";
import { ticketError } from "./ticket-errors";

export type TicketAttachmentSource = "customer" | "staff";

/** SP-09: what the ticket sheet lists. `url` is our gated route, never a storage URL. */
export interface TicketAttachmentDto {
  id: string;
  ticketId: string;
  mediaId: string;
  source: TicketAttachmentSource;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  messageId: string | null;
  addedBy: { id: string; name: string } | null;
  createdAt: Date;
  url: string;
}

/** A customer file from the ticket's conversation that can still be attached. */
export interface TicketAttachmentCandidate {
  mediaId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  at: Date;
}

/** Candidates listed (newest first) and inbound messages scanned for them. */
export const TICKET_CANDIDATES_MAX = 50;
const CANDIDATE_SCAN_MESSAGES = 500;
/** Advisory-lock key for one ticket's attachment set (review M2). */
const ticketAttachmentLockKey = (ticketId: string) => `ticket-att:${ticketId}`;
/** Download cache lifetime (Global Constraints → API). */
const DOWNLOAD_CACHE_CONTROL = "private, max-age=300";
/** Signed URL lifetime when a Spaces object is proxied (never sent to the client). */
const SERVE_TTL_S = 300;

/**
 * Media ids a message's `attach` refers to: the id itself (inbound sinks
 * store the re-hosted Media id) or a URL of ours that carries it
 * (`/api/media/<id>/public?token=` or `/media/<id>/file`).
 */
export function mediaIdsInAttach(attach: string | null | undefined): string[] {
  if (!attach) return [];
  const v = attach.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(v)) return [v];
  const out = new Set<string>();
  for (const m of v.matchAll(/\/media\/([A-Za-z0-9_-]{1,64})\/(?:public|file)\b/g)) out.add(m[1]);
  return [...out];
}

type AttachmentRow = Prisma.TicketAttachmentGetPayload<{
  include: {
    media: { select: { fileName: true; mimeType: true; sizeBytes: true } };
    addedBy: { select: { id: true; name: true } };
  };
}>;

const ROW_INCLUDE = {
  media: { select: { fileName: true, mimeType: true, sizeBytes: true } },
  addedBy: { select: { id: true, name: true } },
} as const;

function toDto(r: AttachmentRow): TicketAttachmentDto {
  return {
    id: r.id,
    ticketId: r.ticketId,
    mediaId: r.mediaId,
    source: r.source as TicketAttachmentSource,
    fileName: r.media?.fileName ?? "",
    mimeType: r.media?.mimeType ?? "application/octet-stream",
    sizeBytes: r.media?.sizeBytes ?? 0,
    messageId: r.messageId ?? null,
    addedBy: r.addedBy ? { id: r.addedBy.id, name: r.addedBy.name } : null,
    createdAt: r.createdAt,
    url: `/api/tickets/${r.ticketId}/attachments/${r.id}`,
  };
}

/**
 * SP-09 ticket attachments (Architecture → Attachments). A file is a Media row
 * (library, storage, sniffing); TicketAttachment links it to one ticket.
 *
 * - Customer files: only Media referenced by an inbound (`from = "them"`)
 *   message of the ticket's own conversation, linked by hand from the
 *   candidates list (ruling 6). They follow the viewer's conversation
 *   visibility everywhere: list (omitted), candidates (empty), download and
 *   unlink (404) (ruling 10, Review Focus 2).
 * - Staff files: uploaded on the ticket through MediaService.finalizeUpload
 *   (SP-13 types, sniffing and limits; ruling 9); they need only tickets.view
 *   to read.
 * - Every id is workspace-scoped: a foreign, missing or other-ticket id is 404.
 * - Link writes take the media lock (lockMediaForReference) so they serialize
 *   against MediaService.remove (ruling 8).
 * - Downloads stream through MediaService.sendResolved, never a 302 or a
 *   storage URL (ruling 5); nothing logs a storage path or a signed URL.
 */
@Injectable()
export class TicketAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  private async ticketOr404(workspaceId: string, ticketId: string, notFound?: () => HttpException) {
    const t = await this.prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, conversationId: true },
    });
    if (!t) throw notFound ? notFound() : new NotFoundException("Ticket not found");
    return t;
  }

  /**
   * Can the viewer see this ticket's conversation (its customer files)? The
   * one rule shared with TicketsService's attachmentCount (review M3): an
   * unrestricted viewer sees them even when the conversation row is gone; a
   * restricted viewer needs the row inside their scope.
   */
  private async conversationVisible(workspaceId: string, conversationId: string | null, viewer?: Viewer) {
    if (!conversationId) return false;
    if (!this.perm) return true;
    try {
      await this.perm.assertConversationVisible(workspaceId, conversationId, viewer);
      return true;
    } catch (e) {
      if (e instanceof NotFoundException) return false;
      throw e;
    }
  }

  /** `GET /tickets/:id/attachments`: newest first; hidden customer files omitted. */
  async list(workspaceId: string, ticketId: string, viewer?: Viewer): Promise<{ items: TicketAttachmentDto[] }> {
    const t = await this.ticketOr404(workspaceId, ticketId);
    const rows = await this.prisma.ticketAttachment.findMany({
      where: { ticketId: t.id, workspaceId },
      include: ROW_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const showCustomer = await this.conversationVisible(workspaceId, t.conversationId, viewer);
    return { items: rows.filter((r) => showCustomer || r.source !== "customer").map(toDto) };
  }

  /**
   * `GET /tickets/:id/attachments/candidates`: customer files on inbound
   * messages of the ticket's conversation not yet attached, newest first,
   * at most TICKET_CANDIDATES_MAX. Empty without a conversation or when the
   * viewer cannot see it.
   */
  async candidates(workspaceId: string, ticketId: string, viewer?: Viewer): Promise<{ items: TicketAttachmentCandidate[] }> {
    const t = await this.ticketOr404(workspaceId, ticketId);
    if (!t.conversationId || !(await this.conversationVisible(workspaceId, t.conversationId, viewer))) {
      return { items: [] };
    }
    const msgs = await this.prisma.message.findMany({
      where: { workspaceId, conversationId: t.conversationId, from: "them", attach: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CANDIDATE_SCAN_MESSAGES,
      select: { id: true, attach: true, createdAt: true },
    });
    const firstSeen = new Map<string, { messageId: string; at: Date }>();
    for (const m of msgs) {
      for (const id of mediaIdsInAttach(m.attach)) if (!firstSeen.has(id)) firstSeen.set(id, { messageId: m.id, at: m.createdAt });
    }
    if (firstSeen.size === 0) return { items: [] };
    const ids = [...firstSeen.keys()];
    const [media, linked] = await Promise.all([
      this.prisma.media.findMany({
        where: { workspaceId, id: { in: ids }, uploadedById: null },
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
      }),
      this.prisma.ticketAttachment.findMany({
        where: { workspaceId, ticketId: t.id, mediaId: { in: ids } },
        select: { mediaId: true },
      }),
    ]);
    const taken = new Set(linked.map((l) => l.mediaId));
    const byId = new Map(media.map((m) => [m.id, m]));
    const items: TicketAttachmentCandidate[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m || taken.has(id)) continue;
      const seen = firstSeen.get(id)!;
      items.push({ mediaId: id, messageId: seen.messageId, fileName: m.fileName, mimeType: m.mimeType, sizeBytes: m.sizeBytes, at: seen.at });
      if (items.length === TICKET_CANDIDATES_MAX) break;
    }
    return { items };
  }

  /**
   * `POST /tickets/:id/attachments {mediaId}`: link a customer file. The media
   * must be on an inbound message of THIS ticket's conversation, in this
   * workspace, and not a staff upload (404 tickets.attachment_source_not_found
   * otherwise, also when the viewer cannot see the conversation).
   */
  async attach(
    workspaceId: string,
    ticketId: string,
    mediaId: string,
    viewer?: Viewer,
    userId?: string,
  ): Promise<TicketAttachmentDto> {
    const t = await this.ticketOr404(workspaceId, ticketId);
    if (!t.conversationId) throw ticketError("tickets.no_conversation");
    if (!(await this.conversationVisible(workspaceId, t.conversationId, viewer))) {
      throw ticketError("tickets.attachment_source_not_found");
    }
    const msgs = await this.prisma.message.findMany({
      where: { workspaceId, conversationId: t.conversationId, from: "them", attach: { contains: mediaId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: { id: true, attach: true },
    });
    const msg = msgs.find((m) => mediaIdsInAttach(m.attach).includes(mediaId));
    if (!msg) throw ticketError("tickets.attachment_source_not_found");
    const media = await this.prisma.media.findFirst({
      where: { id: mediaId, workspaceId, uploadedById: null },
      select: { id: true },
    });
    if (!media) throw ticketError("tickets.attachment_source_not_found");
    return this.link(workspaceId, t.id, mediaId, {
      source: "customer",
      messageId: msg.id,
      addedById: userId ?? viewer?.userId ?? null,
      gone: () => ticketError("tickets.attachment_source_not_found"),
    });
  }

  /**
   * `POST /tickets/:id/attachments/upload` (multipart `file`): a staff file.
   * Runs the SP-13 upload (types, sniffing, limits; `media.*` keys on
   * refusal) and links the new library file with source "staff". Needs only
   * tickets.update, not the library's own upload permission.
   */
  async upload(
    workspaceId: string,
    ticketId: string,
    file: Express.Multer.File,
    userId: string,
  ): Promise<TicketAttachmentDto> {
    let ticket: { id: string };
    try {
      ticket = await this.ticketOr404(workspaceId, ticketId);
      const count = await this.prisma.ticketAttachment.count({ where: { ticketId: ticket.id, workspaceId } });
      if (count >= TICKET_ATTACHMENTS_MAX) throw ticketError("tickets.attachments_full", { limit: TICKET_ATTACHMENTS_MAX });
    } catch (e) {
      // Refused before the upload ran: drop the staged temp file ourselves.
      if (file?.path) {
        const fs = await import("node:fs/promises");
        await fs.unlink(file.path).catch(() => {});
      }
      throw e;
    }
    // finalizeUpload validates, stores and always removes the temp file.
    const media = await this.media.finalizeUpload(workspaceId, file, userId);
    try {
      return await this.link(workspaceId, ticket.id, media.id, {
        source: "staff",
        messageId: null,
        addedById: userId,
        gone: () => new NotFoundException("Media not found"),
      });
    } catch (e) {
      // Not linked (ticket deleted or full meanwhile): don't leave an orphan upload behind.
      await this.media.remove(workspaceId, media.id).catch(() => undefined);
      throw e;
    }
  }

  /**
   * One link write: in a transaction holding the media lock (the same lock
   * MediaService.remove takes) and then the ticket's attachment lock (so two
   * links of different files cannot both pass the cap check, review M2),
   * re-read the ticket by (id, workspace), then refuse a duplicate (409) or a
   * full ticket (400), then insert. Lock order is always media, then ticket.
   */
  private async link(
    workspaceId: string,
    ticketId: string,
    mediaId: string,
    opts: { source: TicketAttachmentSource; messageId: string | null; addedById: string | null; gone: () => HttpException },
  ): Promise<TicketAttachmentDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      try {
        await lockMediaForReference(tx, workspaceId, mediaId);
      } catch (e) {
        if (e instanceof NotFoundException) throw opts.gone();
        throw e;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ticketAttachmentLockKey(ticketId)}))`;
      const t = await tx.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { id: true } });
      if (!t) throw new NotFoundException("Ticket not found");
      const dup = await tx.ticketAttachment.findFirst({ where: { ticketId, mediaId }, select: { id: true } });
      if (dup) throw ticketError("tickets.attachment_exists", { attachmentId: dup.id });
      const count = await tx.ticketAttachment.count({ where: { ticketId, workspaceId } });
      if (count >= TICKET_ATTACHMENTS_MAX) throw ticketError("tickets.attachments_full", { limit: TICKET_ATTACHMENTS_MAX });
      try {
        const row = await tx.ticketAttachment.create({
          data: {
            workspaceId,
            ticketId,
            mediaId,
            source: opts.source,
            messageId: opts.messageId,
            addedById: opts.addedById,
          },
          select: { id: true },
        });
        return row.id;
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") throw ticketError("tickets.attachment_exists");
        throw e;
      }
    });
    const row = await this.prisma.ticketAttachment.findFirst({ where: { id, workspaceId }, include: ROW_INCLUDE });
    if (!row) throw ticketError("tickets.attachment_not_found");
    return toDto(row);
  }

  /** The attachment row a viewer may open, or 404 tickets.attachment_not_found. */
  private async openable(workspaceId: string, ticketId: string, attId: string, viewer?: Viewer) {
    const notFound = () => ticketError("tickets.attachment_not_found");
    const t = await this.ticketOr404(workspaceId, ticketId, notFound);
    const att = await this.prisma.ticketAttachment.findFirst({
      where: { id: attId, ticketId: t.id, workspaceId },
      select: { id: true, mediaId: true, source: true },
    });
    if (!att) throw notFound();
    if (att.source === "customer" && !(await this.conversationVisible(workspaceId, t.conversationId, viewer))) {
      throw notFound();
    }
    return att;
  }

  /**
   * `GET /tickets/:id/attachments/:attId`: the bytes. The media row is loaded
   * by (mediaId, workspace) directly, not through MediaService.get(viewer):
   * the ticket's rule decides here, not the library's.
   */
  async serve(workspaceId: string, ticketId: string, attId: string, res: Response, viewer?: Viewer): Promise<void> {
    const att = await this.openable(workspaceId, ticketId, attId, viewer);
    const row = await this.prisma.media.findFirst({ where: { id: att.mediaId, workspaceId } });
    if (!row) throw ticketError("tickets.attachment_not_found");
    const resolved = await this.media.resolveServeForRow(row, SERVE_TTL_S);
    await this.media.sendResolved(res, resolved, {
      cacheControl: DOWNLOAD_CACHE_CONTROL,
      label: `ticket attachment ${att.id}`,
    });
  }

  /** `DELETE /tickets/:id/attachments/:attId`: removes the link; the file stays in the library. */
  async unlink(workspaceId: string, ticketId: string, attId: string, viewer?: Viewer): Promise<{ ok: true }> {
    const att = await this.openable(workspaceId, ticketId, attId, viewer);
    const { count } = await this.prisma.ticketAttachment.deleteMany({ where: { id: att.id, ticketId, workspaceId } });
    if (count === 0) throw ticketError("tickets.attachment_not_found");
    return { ok: true };
  }
}
