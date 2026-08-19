import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { SegmentsService, type SegmentFilter } from "./segments.service";
import { MarketingOutboundService } from "./marketing-outbound.service";
import { SegmentsSyncScheduler } from "./segments-sync.scheduler";

class SegmentFilterDto implements SegmentFilter {
  @IsOptional() @IsArray() @IsString({ each: true }) lifecycle?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) industry?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) source?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tagsAll?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tagsAny?: string[];
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsBoolean() hasPhone?: boolean;
}

class CreateSegmentDto {
  @IsString() @IsNotEmpty() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(64) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsIn(["crm", "manual"]) origin?: "crm" | "manual";
  @IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;
}

class UpdateSegmentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) name?: string;
  @IsOptional() @IsString() @MaxLength(64) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;
}

class PreviewSegmentDto {
  @ValidateNested() @Type(() => SegmentFilterDto) filter!: SegmentFilterDto;
}

class AddMembersDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
}

@Controller("segments")
export class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: SegmentsService,
    private readonly outbound: MarketingOutboundService,
  ) {}

  @Get()
  async list(@CurrentWorkspace() workspaceId: string) {
    const rows = await this.prisma.segment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
    // Counts are computed by running each segment's filter against Contact.
    // Cheap enough at the current scale (single-digit segments per workspace);
    // if it ever bites we cache by hash(filter) or materialize.
    const counts = await Promise.all(
      rows.map((s) =>
        s.origin === "crm"
          ? this.svc.countByFilter(workspaceId, this.svc.parseFilter(s.filter))
          : this.prisma.segmentMember.count({ where: { segmentId: s.id } }),
      ),
    );
    return rows.map((s, i) => ({
      id: s.id,
      name: s.name,
      nameAr: s.nameAr,
      color: s.color,
      origin: s.origin,
      filter: this.svc.parseFilter(s.filter),
      count: counts[i],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  @Post("preview")
  preview(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PreviewSegmentDto,
  ) {
    return this.svc
      .countByFilter(workspaceId, dto.filter)
      .then((count) => ({ count }));
  }

  @Post()
  async create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateSegmentDto,
  ) {
    const seg = await this.prisma.segment.create({
      data: {
        workspaceId,
        name: dto.name,
        nameAr: dto.nameAr ?? null,
        color: dto.color ?? null,
        filter: JSON.stringify(dto.filter ?? {}),
        origin: dto.origin ?? "crm",
      },
    });
    void this.outbound.emitSegmentUpserted(workspaceId, seg.id);
    return seg;
  }

  @Patch(":id")
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    const existing = await this.prisma.segment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Segment not found");
    if (existing.origin === 'hjz') {
      throw new NotFoundException("Segment is managed by HJZ and read-only here");
    }
    const updated = await this.prisma.segment.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        nameAr: dto.nameAr === undefined ? undefined : (dto.nameAr ?? null),
        color: dto.color === undefined ? undefined : (dto.color ?? null),
        filter: dto.filter === undefined ? undefined : JSON.stringify(dto.filter),
      },
    });
    void this.outbound.emitSegmentUpserted(workspaceId, updated.id);
    return updated;
  }

  @Delete(":id")
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    const existing = await this.prisma.segment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Segment not found");
    if (existing.origin === 'hjz') {
      throw new NotFoundException("Segment is managed by HJZ and read-only here");
    }
    await this.prisma.segment.delete({ where: { id } });
    void this.outbound.emitSegmentDeleted(workspaceId, id);
    return { ok: true };
  }

  /** Resolve a segment, asserting it's a manual group in this workspace. */
  private async requireManual(workspaceId: string, id: string) {
    const seg = await this.prisma.segment.findFirst({ where: { id, workspaceId } });
    if (!seg) throw new NotFoundException("Segment not found");
    if (seg.origin !== "manual") {
      throw new BadRequestException("Members can only be managed on manual groups");
    }
    return seg;
  }

  @Post(":id/members")
  async addMembers(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: AddMembersDto,
  ) {
    await this.requireManual(workspaceId, id);
    const ids = [...new Set(dto.contactIds)];
    const found = await this.prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException("One or more contacts not found in this workspace");
    }
    const res = await this.prisma.segmentMember.createMany({
      data: ids.map((contactId) => ({ segmentId: id, contactId })),
      skipDuplicates: true,
    });
    void this.outbound.emitSegmentUpserted(workspaceId, id);
    return { added: res.count };
  }

  @Delete(":id/members/:contactId")
  async removeMember(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Param("contactId") contactId: string,
  ) {
    await this.requireManual(workspaceId, id);
    await this.prisma.segmentMember.deleteMany({ where: { segmentId: id, contactId } });
    void this.outbound.emitSegmentUpserted(workspaceId, id);
    return { ok: true };
  }

  @Get(":id/members")
  async listMembers(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("search") search?: string,
  ) {
    await this.requireManual(workspaceId, id);
    const members = await this.prisma.segmentMember.findMany({
      where: {
        segmentId: id,
        contact: search
          ? { name: { contains: search, mode: "insensitive" } }
          : undefined,
      },
      include: { contact: { select: { id: true, name: true, phone: true, source: true } } },
      take: 100,
      orderBy: { addedAt: "desc" },
    });
    return members.map((m) => m.contact);
  }

  @Post('admin/resync-hjz')
  resyncHjz(@CurrentWorkspace() workspaceId: string) {
    return this.outbound.resyncAllToHjz(workspaceId);
  }
}

@Module({
  controllers: [SegmentsController],
  providers: [SegmentsService, MarketingOutboundService, SegmentsSyncScheduler],
  exports: [SegmentsService, MarketingOutboundService],
})
export class SegmentsModule {}
