import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
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
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTemplateDto) {
    // Submit to Meta. Throws if WhatsApp isn't connected, which surfaces to the
    // client as a NotFoundException — the UI prompts the user to connect first.
    return this.wa.submitTemplate(workspaceId, {
      name: dto.name,
      lang: dto.lang,
      category: dto.category,
      body: dto.body,
      footer: dto.footer,
      headerType: dto.headerType,
      headerContent: dto.headerContent,
      buttons: dto.buttons as TemplateButton[] | undefined,
    });
  }
}

@Module({
  imports: [IntegrationsModule],
  controllers: [TemplatesController],
})
export class TemplatesModule {}
