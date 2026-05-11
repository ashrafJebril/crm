import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";

const STATUSES = ["running", "scheduled", "draft", "completed", "paused"] as const;

class CreateCampaignDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() audience!: string;
  @IsString() @IsNotEmpty() channel!: string;
  @IsString() @IsNotEmpty() agent!: string;
  @IsOptional() @IsIn([...STATUSES]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsString() schedule?: string;
  @IsOptional() @IsInt() @Min(0) recipients?: number;
}

class UpdateCampaignDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() agent?: string;
  @IsOptional() @IsIn([...STATUSES]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsString() schedule?: string;
  @IsOptional() @IsInt() @Min(0) recipients?: number;
  @IsOptional() @IsInt() @Min(0) sent?: number;
  @IsOptional() @IsInt() @Min(0) delivered?: number;
  @IsOptional() @IsInt() @Min(0) read?: number;
  @IsOptional() @IsInt() @Min(0) replied?: number;
  @IsOptional() @IsInt() @Min(0) conversions?: number;
}

@Controller("campaigns")
class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get() list() {
    return this.prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
  }

  @Get(":id") get(@Param("id") id: string) {
    return this.prisma.campaign.findUnique({ where: { id } });
  }

  @Post() create(@Body() dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: { ...dto, status: dto.status ?? "draft", recipients: dto.recipients ?? 0 },
    });
  }

  @Patch(":id") update(@Param("id") id: string, @Body() dto: UpdateCampaignDto) {
    return this.prisma.campaign.update({ where: { id }, data: dto });
  }

  @Delete(":id") remove(@Param("id") id: string) {
    return this.prisma.campaign.delete({ where: { id } }).then(() => ({ ok: true }));
  }
}

@Module({ controllers: [CampaignsController] })
export class CampaignsModule {}
