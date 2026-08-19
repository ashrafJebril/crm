import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

/** Deterministic 12-step hue for auto-colored tags (matches the absorb
 *  migration's hashtext formula in spirit; exact parity isn't required —
 *  colors are cosmetic — but determinism per name is). */
export function hueForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return String((Math.abs(h) % 12) * 30);
}

class CreateTagDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name!: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class UpdateTagDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class AssignTagsDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) add?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
}

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All catalog tags with live usage counts (one grouped jsonb pass). */
  async list(workspaceId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    const counts = await this.prisma.$queryRaw<{ name: string; count: bigint }[]>`
      SELECT e AS name, count(*)::bigint AS count
      FROM "Contact" c, jsonb_array_elements_text(c."tags"::jsonb) e
      WHERE c."workspaceId" = ${workspaceId}
      GROUP BY e
    `;
    const byName = new Map(counts.map((r) => [r.name, Number(r.count)]));
    return tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      usageCount: byName.get(t.name) ?? 0,
    }));
  }

  /** Idempotent create — quick-create callers shouldn't 409 on races. */
  async create(workspaceId: string, rawName: string, color?: string) {
    const name = rawName.trim();
    const existing = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
    if (existing) return existing;
    try {
      return await this.prisma.tag.create({
        data: { workspaceId, name, color: color ?? hueForName(name) },
      });
    } catch (e) {
      // Unique race: someone created it between the check and the insert.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
        if (row) return row;
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: { name?: string; color?: string }) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const newName = dto.name?.trim();
    let contactsUpdated = 0;
    if (newName && newName !== tag.name) {
      // Exact-element rename inside the JSON string arrays — "VIP" must never
      // touch "VIPER" (jsonb element equality, not substring).
      contactsUpdated = await this.prisma.$executeRaw`
        UPDATE "Contact"
        SET "tags" = (
          SELECT COALESCE(jsonb_agg(CASE WHEN e = ${tag.name} THEN ${newName} ELSE e END), '[]'::jsonb)::text
          FROM jsonb_array_elements_text("tags"::jsonb) e
        )
        WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${tag.name}
      `;
    }
    const updated = await this.prisma.tag.update({
      where: { id },
      data: { name: newName ?? undefined, color: dto.color ?? undefined },
    });
    return { tag: updated, contactsUpdated };
  }

  async remove(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const contactsUpdated = await this.prisma.$executeRaw`
      UPDATE "Contact"
      SET "tags" = (
        SELECT COALESCE(jsonb_agg(e) FILTER (WHERE e <> ${tag.name}), '[]'::jsonb)::text
        FROM jsonb_array_elements_text("tags"::jsonb) e
      )
      WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${tag.name}
    `;
    await this.prisma.tag.delete({ where: { id } });
    return { ok: true as const, contactsUpdated };
  }

  /** Bulk add/remove tag names on contacts; unknown names quick-create. */
  async assign(
    workspaceId: string,
    input: { contactIds: string[]; add?: string[]; remove?: string[] },
  ) {
    const ids = [...new Set(input.contactIds)];
    const found = await this.prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, tags: true },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException("One or more contacts not found in this workspace");
    }
    const add = (input.add ?? []).map((n) => n.trim()).filter(Boolean);
    const remove = new Set((input.remove ?? []).map((n) => n.trim()).filter(Boolean));
    for (const name of add) await this.create(workspaceId, name);
    let contactsUpdated = 0;
    for (const c of found) {
      let tags: string[];
      try {
        const parsed = JSON.parse(c.tags);
        tags = Array.isArray(parsed) ? parsed : [];
      } catch {
        tags = [];
      }
      const next = [...new Set([...tags.filter((t) => !remove.has(t)), ...add])];
      if (JSON.stringify(next) !== JSON.stringify(tags)) {
        await this.prisma.contact.update({
          where: { id: c.id },
          data: { tags: JSON.stringify(next) },
        });
        contactsUpdated += 1;
      }
    }
    return { contactsUpdated };
  }
}

@Controller("tags")
class TagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTagDto) {
    return this.svc.create(workspaceId, dto.name, dto.color);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Post("assign")
  assign(@CurrentWorkspace() workspaceId: string, @Body() dto: AssignTagsDto) {
    return this.svc.assign(workspaceId, dto);
  }
}

@Module({
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
