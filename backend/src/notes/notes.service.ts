import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";

@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  listForContact(contactId: string) {
    return this.prisma.note.findMany({
      where: { contactId },
      orderBy: { createdAt: "desc" },
    });
  }

  listForConversation(conversationId: string) {
    return this.prisma.note.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const row = await this.prisma.note.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Note not found");
    return row;
  }

  async create(dto: CreateNoteDto, authorUserId: string | null) {
    const contact = await this.prisma.contact.findUnique({
      where: { id: dto.contactId },
    });
    if (!contact) throw new NotFoundException("Contact not found");
    return this.prisma.note.create({
      data: {
        contactId: dto.contactId,
        conversationId: dto.conversationId ?? null,
        body: dto.body,
        authorUserId,
      },
    });
  }

  async update(id: string, dto: UpdateNoteDto) {
    await this.get(id);
    return this.prisma.note.update({
      where: { id },
      data: { body: dto.body },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.note.delete({ where: { id } });
    return { ok: true };
  }
}
