import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";

@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  listForContact(workspaceId: string, contactId: string) {
    return this.prisma.note.findMany({
      where: { workspaceId, contactId },
      orderBy: { createdAt: "desc" },
    });
  }

  listForConversation(workspaceId: string, conversationId: string) {
    return this.prisma.note.findMany({
      where: { workspaceId, conversationId },
      orderBy: { createdAt: "desc" },
    });
  }

  listForTicket(workspaceId: string, ticketId: string) {
    return this.prisma.note.findMany({
      where: { workspaceId, ticketId },
      orderBy: { createdAt: "desc" },
    });
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
    return this.prisma.note.create({
      data: {
        workspaceId,
        contactId: dto.contactId,
        conversationId: dto.conversationId ?? null,
        ticketId: dto.ticketId ?? null,
        body: dto.body,
        authorUserId,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateNoteDto) {
    await this.get(workspaceId, id);
    return this.prisma.note.update({
      where: { id },
      data: { body: dto.body },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.note.delete({ where: { id } });
    return { ok: true };
  }
}
