import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";

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

  @Get() list() {
    return this.prisma.template.findMany({ orderBy: { uses: "desc" } });
  }

  @Get(":id") get(@Param("id") id: string) {
    return this.prisma.template.findUnique({ where: { id } });
  }

  @Post() create(@Body() dto: CreateTemplateDto) {
    return this.prisma.template.create({
      data: { ...dto, status: dto.status ?? "pending", uses: dto.uses ?? 0 },
    });
  }
}

@Module({ controllers: [TemplatesController] })
export class TemplatesModule {}
