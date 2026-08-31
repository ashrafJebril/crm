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
  Query,
} from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
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
import { IntegrationsModule } from "../integrations/integrations.module";
import { TemplatesService } from "./templates.service";

const CATEGORIES = ["TRANSACTIONAL", "UTILITY", "MARKETING", "AUTHENTICATION"] as const;
const HEADER_TYPES = ["text", "image", "video", "document"] as const;

class TemplateButtonDto {
  @IsIn(["QUICK_REPLY", "URL", "PHONE_NUMBER"]) type!: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  @IsString() @IsNotEmpty() @MaxLength(25) text!: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() phone_number?: string;
}

/**
 * Note what is NOT here any more: `status` and `uses`.
 *
 * They used to be accepted from the client as an "escape hatch" that skipped
 * Meta submission and stored the row locally as `approved`. That is exactly how
 * the workspace ended up advertising four approved templates Meta had never
 * seen. Status now comes only from Meta, via TemplatesService.
 */
class CreateTemplateDto {
  @IsString() @IsNotEmpty() @MaxLength(512) name!: string;
  @IsIn(["en", "ar"]) lang!: "en" | "ar";
  @IsIn([...CATEGORIES]) category!: (typeof CATEGORIES)[number];
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() @MaxLength(60) footer?: string;
  @IsOptional() @IsIn([...HEADER_TYPES]) headerType?: (typeof HEADER_TYPES)[number];
  @IsOptional() @IsString() headerContent?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];

  /**
   * Sample values for the body's {{1}}, {{2}} … placeholders, in order.
   *
   * Meta REQUIRES these and judges them: it rejected a template whose samples
   * were the generic "sample1"/"sample2" with rejected_reason=INVALID_FORMAT,
   * while realistic values were accepted for review (verified live
   * 2026-08-28). They must look like real content.
   */
  @IsOptional() @IsArray() @IsString({ each: true }) bodyExamples?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) headerExamples?: string[];

  /** Import a pre-approved template from Meta's library — no review wait. */
  @IsOptional() @IsString() libraryTemplateName?: string;
}

class UpdateTemplateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(512) name?: string;
  @IsOptional() @IsIn(["en", "ar"]) lang?: "en" | "ar";
  @IsOptional() @IsIn([...CATEGORIES]) category?: (typeof CATEGORIES)[number];
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() @MaxLength(60) footer?: string;
  @IsOptional() @IsIn([...HEADER_TYPES]) headerType?: (typeof HEADER_TYPES)[number];
  @IsOptional() @IsString() headerContent?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];
}

@Controller("templates")
class TemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
  ) {}

  /** Reconciled against Meta on every read — see TemplatesService.list. */
  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.templates.list(workspaceId);
  }

  /**
   * Look up a pre-approved library template before importing it. Declared
   * BEFORE `:id` — Nest matches in declaration order, so the reverse would
   * make "library" look like a template id.
   */
  @Get("library")
  library(
    @CurrentWorkspace() workspaceId: string,
    @Query("name") name: string,
    @Query("language") language?: string,
  ) {
    return this.templates.lookupLibraryTemplate(workspaceId, name, language);
  }

  @Get(":id")
  async get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    const row = await this.prisma.template.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(workspaceId, {
      name: dto.name,
      lang: dto.lang,
      category: dto.category,
      body: dto.body,
      footer: dto.footer,
      headerType: dto.headerType,
      headerContent: dto.headerContent,
      buttons: dto.buttons as unknown as Array<Record<string, unknown>> | undefined,
      bodyExamples: dto.bodyExamples,
      headerExamples: dto.headerExamples,
      libraryTemplateName: dto.libraryTemplateName,
    });
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(workspaceId, id, {
      name: dto.name,
      lang: dto.lang,
      category: dto.category,
      body: dto.body,
      footer: dto.footer,
      headerType: dto.headerType,
      headerContent: dto.headerContent,
      buttons: dto.buttons as unknown as Array<Record<string, unknown>> | undefined,
    });
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.templates.remove(workspaceId, id);
  }

  @Post(":id/duplicate")
  duplicate(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.templates.duplicate(workspaceId, id);
  }
}

@Module({
  imports: [IntegrationsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
