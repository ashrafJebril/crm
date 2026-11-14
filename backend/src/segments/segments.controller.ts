import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { SegmentsService } from "./segments.service";
import { MarketingOutboundService } from "./marketing-outbound.service";
import { addManualMembers, requireManualGroup } from "./segment-members";
import { audienceNotFound } from "./audience-errors";
import { AddMembersDto, CreateSegmentDto, PreviewSegmentDto, UpdateSegmentDto } from "./segments.dto";

/**
 * `/segments` ("audience" is the product word, `segment` the storage word;
 * ruling 15). Every handler loads its row by `(id, workspaceId)` first, so a
 * foreign path id is a 404.
 */
@Controller("segments")
export class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: SegmentsService,
    private readonly outbound: MarketingOutboundService,
  ) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listRows(workspaceId);
  }

  @Post("preview")
  preview(@CurrentWorkspace() workspaceId: string, @Body() dto: PreviewSegmentDto) {
    return this.svc.preview(workspaceId, dto);
  }

  @Post()
  async create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateSegmentDto) {
    const row = await this.svc.save(workspaceId, {
      name: dto.name,
      nameAr: dto.nameAr,
      color: dto.color,
      origin: dto.origin,
      filter: dto.filter,
      rules: dto.rules,
    });
    void this.outbound.emitSegmentUpserted(workspaceId, row.id);
    return row;
  }

  @Get(":id")
  detail(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.detail(workspaceId, id);
  }

  @Patch(":id")
  async update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateSegmentDto) {
    const row = await this.svc.save(
      workspaceId,
      { name: dto.name, nameAr: dto.nameAr, color: dto.color, filter: dto.filter, rules: dto.rules },
      { id, version: dto.version },
    );
    void this.outbound.emitSegmentUpserted(workspaceId, row.id);
    return row;
  }

  /** Unchanged in Task 1; the reference-aware delete (ruling 7) is Task 2. */
  @Delete(":id")
  async remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    const existing = await this.prisma.segment.findFirst({ where: { id, workspaceId } });
    if (!existing) throw audienceNotFound();
    if (existing.origin === "hjz") {
      throw new NotFoundException("Segment is managed by HJZ and read-only here");
    }
    await this.prisma.segment.delete({ where: { id } });
    void this.outbound.emitSegmentDeleted(workspaceId, id);
    return { ok: true };
  }

  @Get(":id/contacts")
  contacts(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("after") after?: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ) {
    return this.svc.pageContacts(workspaceId, id, { after, q, limit });
  }

  @Get(":id/count")
  count(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.count(workspaceId, id);
  }

  @Get(":id/candidates")
  candidates(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("after") after?: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ) {
    return this.svc.candidates(workspaceId, id, { after, q, limit });
  }

  private requireManual(workspaceId: string, id: string) {
    return requireManualGroup(this.prisma, workspaceId, id);
  }

  @Post(":id/members")
  async addMembers(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: AddMembersDto) {
    return addManualMembers(this.prisma, this.outbound, workspaceId, id, dto.contactIds);
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
  async listMembers(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Query("search") search?: string) {
    await this.requireManual(workspaceId, id);
    const members = await this.prisma.segmentMember.findMany({
      where: {
        segmentId: id,
        contact: search ? { name: { contains: search, mode: "insensitive" } } : undefined,
      },
      include: { contact: { select: { id: true, name: true, phone: true, source: true } } },
      take: 100,
      orderBy: { addedAt: "desc" },
    });
    return members.map((m) => m.contact);
  }

  @Post("admin/resync-hjz")
  resyncHjz(@CurrentWorkspace() workspaceId: string) {
    return this.outbound.resyncAllToHjz(workspaceId);
  }
}
