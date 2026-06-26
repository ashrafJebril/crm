import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
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
  @ValidateNested() @Type(() => SegmentFilterDto) filter!: SegmentFilterDto;
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

@Controller("segments")
class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: SegmentsService,
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
        this.svc.countByFilter(workspaceId, this.svc.parseFilter(s.filter)),
      ),
    );
    return rows.map((s, i) => ({
      id: s.id,
      name: s.name,
      nameAr: s.nameAr,
      color: s.color,
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
    return this.prisma.segment.create({
      data: {
        workspaceId,
        name: dto.name,
        nameAr: dto.nameAr ?? null,
        color: dto.color ?? null,
        filter: JSON.stringify(dto.filter),
      },
    });
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
    return this.prisma.segment.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        nameAr: dto.nameAr === undefined ? undefined : (dto.nameAr ?? null),
        color: dto.color === undefined ? undefined : (dto.color ?? null),
        filter: dto.filter === undefined ? undefined : JSON.stringify(dto.filter),
      },
    });
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
    await this.prisma.segment.delete({ where: { id } });
    return { ok: true };
  }
}

@Module({
  controllers: [SegmentsController],
  providers: [SegmentsService],
  exports: [SegmentsService],
})
export class SegmentsModule {}
