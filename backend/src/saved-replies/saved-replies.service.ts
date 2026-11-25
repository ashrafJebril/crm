import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateSavedReplyDto, UpdateSavedReplyDto } from "./saved-replies.dto";

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";
const SHORTCUT_EXISTS = "saved_replies.shortcut_exists";

/** SP-31 per-workspace canned replies. The unique index on
 *  (workspaceId, shortcut) is the arbiter under concurrent creates: P2002 -> 409. */
@Injectable()
export class SavedRepliesService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.savedReply.findMany({ where: { workspaceId }, orderBy: [{ shortcut: "asc" }] });
  }

  async create(workspaceId: string, dto: CreateSavedReplyDto) {
    try {
      return await this.prisma.savedReply.create({
        data: { workspaceId, title: dto.title, body: dto.body, bodyAr: dto.bodyAr ?? null, shortcut: dto.shortcut },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(SHORTCUT_EXISTS);
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateSavedReplyDto) {
    const existing = await this.prisma.savedReply.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundException("Saved reply not found");
    try {
      return await this.prisma.savedReply.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.body !== undefined ? { body: dto.body } : {}),
          ...(dto.bodyAr !== undefined ? { bodyAr: dto.bodyAr || null } : {}),
          ...(dto.shortcut !== undefined ? { shortcut: dto.shortcut } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(SHORTCUT_EXISTS);
      throw e;
    }
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.savedReply.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundException("Saved reply not found");
    await this.prisma.savedReply.delete({ where: { id } });
    return { ok: true as const };
  }
}
