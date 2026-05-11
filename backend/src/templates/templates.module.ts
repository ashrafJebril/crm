import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

class CreateTemplateDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsIn(["en", "ar"]) lang!: "en" | "ar";
  @IsIn(["TRANSACTIONAL", "UTILITY", "MARKETING", "AUTHENTICATION"]) category!: string;
  @IsOptional() @IsIn(["approved", "pending", "rejected"]) status?: string;
  @IsOptional() @IsInt() @Min(0) uses?: number;
}

@Controller("templates")
class TemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.prisma.template.findMany({
      where: { workspaceId },
      orderBy: { uses: "desc" },
    });
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.prisma.template.findFirst({ where: { id, workspaceId } });
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTemplateDto) {
    return this.prisma.template.create({
      data: { ...dto, workspaceId, status: dto.status ?? "pending", uses: dto.uses ?? 0 },
    });
  }
}

@Module({ controllers: [TemplatesController] })
export class TemplatesModule {}
