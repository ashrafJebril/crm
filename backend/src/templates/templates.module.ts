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
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { IntegrationsModule } from "../integrations/integrations.module";
import { WhatsAppService, type TemplateButton } from "../integrations/whatsapp.service";

const CATEGORIES = ["TRANSACTIONAL", "UTILITY", "MARKETING", "AUTHENTICATION"] as const;
const HEADER_TYPES = ["text", "image", "video", "document"] as const;

class TemplateButtonDto {
  @IsIn(["QUICK_REPLY", "URL", "PHONE_NUMBER"]) type!: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  @IsString() @IsNotEmpty() @MaxLength(25) text!: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() phone_number?: string;
}

class CreateTemplateDto {
  @IsString() @IsNotEmpty() @MaxLength(512) name!: string;
  @IsIn(["en", "ar"]) lang!: "en" | "ar";
  @IsIn([...CATEGORIES]) category!: (typeof CATEGORIES)[number];
  @IsString() @IsNotEmpty() body!: string;
  @IsOptional() @IsString() @MaxLength(60) footer?: string;
  @IsOptional() @IsIn([...HEADER_TYPES]) headerType?: (typeof HEADER_TYPES)[number];
  @IsOptional() @IsString() headerContent?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];

  // Internal escape hatch: skip Meta submission and just store the row locally.
  // Useful for previewing approved templates seeded from data fixtures.
  @IsOptional() @IsIn(["approved", "pending", "rejected"]) status?: string;
  @IsOptional() @IsInt() @Min(0) uses?: number;
}

class UpdateTemplateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(512) name?: string;
  @IsOptional() @IsIn(["en", "ar"]) lang?: "en" | "ar";
  @IsOptional() @IsIn([...CATEGORIES]) category?: (typeof CATEGORIES)[number];
  @IsOptional() @IsString() @IsNotEmpty() body?: string;
  @IsOptional() @IsString() @MaxLength(60) footer?: string;
  @IsOptional() @IsIn([...HEADER_TYPES]) headerType?: (typeof HEADER_TYPES)[number];
  @IsOptional() @IsString() headerContent?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];
  @IsOptional() @IsIn(["approved", "pending", "rejected"]) status?: string;
}

@Controller("templates")
class TemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsAppService,
  ) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.prisma.template.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.prisma.template.findFirst({ where: { id, workspaceId } });
  }

  @Post()
  async create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateTemplateDto,
  ) {
    // Try Meta submission first; if WhatsApp isn't connected fall back to a
    // local-only save so the workspace can manage templates before connecting
    // (or without connecting at all).
    try {
      return await this.wa.submitTemplate(workspaceId, {
        name: dto.name,
        lang: dto.lang,
        category: dto.category,
        body: dto.body,
        footer: dto.footer,
        headerType: dto.headerType,
        headerContent: dto.headerContent,
        buttons: dto.buttons as TemplateButton[] | undefined,
      });
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      const buttonsJson =
        dto.buttons && dto.buttons.length > 0 ? JSON.stringify(dto.buttons) : null;
      return this.prisma.template.create({
        data: {
          workspaceId,
          name: dto.name,
          lang: dto.lang,
          category: dto.category,
          status: dto.status ?? "approved",
          uses: dto.uses ?? 0,
          body: dto.body,
          footer: dto.footer ?? null,
          headerType: dto.headerType ?? null,
          headerContent: dto.headerContent ?? null,
          buttons: buttonsJson,
        },
      });
    }
  }

  @Patch(":id")
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    const existing = await this.prisma.template.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Template not found");
    return this.prisma.template.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        lang: dto.lang ?? undefined,
        category: dto.category ?? undefined,
        status: dto.status ?? undefined,
        body: dto.body ?? undefined,
        footer: dto.footer === undefined ? undefined : (dto.footer ?? null),
        headerType:
          dto.headerType === undefined ? undefined : (dto.headerType ?? null),
        headerContent:
          dto.headerContent === undefined ? undefined : (dto.headerContent ?? null),
        buttons:
          dto.buttons === undefined
            ? undefined
            : dto.buttons.length > 0
              ? JSON.stringify(dto.buttons)
              : null,
      },
    });
  }

  @Delete(":id")
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    const existing = await this.prisma.template.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Template not found");
    await this.prisma.template.delete({ where: { id } });
    return { ok: true };
  }

  @Post(":id/duplicate")
  async duplicate(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    const src = await this.prisma.template.findFirst({
      where: { id, workspaceId },
    });
    if (!src) throw new NotFoundException("Template not found");
    return this.prisma.template.create({
      data: {
        workspaceId,
        name: `${src.name}_copy`,
        lang: src.lang,
        category: src.category,
        status: "approved",
        uses: 0,
        body: src.body,
        footer: src.footer,
        headerType: src.headerType,
        headerContent: src.headerContent,
        buttons: src.buttons,
      },
    });
  }
}

@Module({
  imports: [IntegrationsModule],
  controllers: [TemplatesController],
})
export class TemplatesModule {}
