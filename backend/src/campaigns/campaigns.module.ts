import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { IntegrationsModule } from "../integrations/integrations.module";
import type { ZernioBroadcastVariable } from "../integrations/zernio.client";
import { CampaignSendService } from "./campaign-send.service";

class CreateCampaignDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() audience!: string;
  @IsString() @IsNotEmpty() channel!: string;
  @IsOptional() @IsString() schedule?: string;
  @IsOptional() @IsInt() @Min(0) recipients?: number;
  @IsOptional() @IsString() segmentId?: string;
  @IsOptional() @IsString() templateId?: string;
}

/** Drafts only. Status and delivery counters come from Zernio, never the client. */
class UpdateCampaignDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() schedule?: string;
  @IsOptional() @IsInt() @Min(0) recipients?: number;
  @IsOptional() @IsString() segmentId?: string;
  @IsOptional() @IsString() templateId?: string;
}

const VARIABLE_FIELDS = ["name", "phone", "email", "company", "custom"] as const;

class BroadcastVariableDto {
  @IsIn([...VARIABLE_FIELDS]) field!: (typeof VARIABLE_FIELDS)[number];
  @ValidateIf((v: BroadcastVariableDto) => v.field === "custom")
  @IsString()
  @IsNotEmpty()
  customValue?: string;
}

class LaunchCampaignDto {
  @IsIn(["now", "schedule"]) mode!: "now" | "schedule";
  @ValidateIf((d: LaunchCampaignDto) => d.mode === "schedule") @IsISO8601() scheduledAt?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BroadcastVariableDto)
  variables!: BroadcastVariableDto[];
}

@Controller("campaigns")
class CampaignsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly send: CampaignSendService,
  ) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.prisma.campaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Reach and Meta cost estimate for an audience (declared before :id). */
  @Get("preview")
  preview(@CurrentWorkspace() workspaceId: string, @Query("segmentId") segmentId?: string) {
    return this.send.preview(workspaceId, segmentId || null);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.prisma.campaign.findFirst({ where: { id, workspaceId } });
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        ...dto,
        workspaceId,
        status: "draft",
        recipients: dto.recipients ?? 0,
      },
    });
  }

  @Patch(":id")
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    const existing = await this.prisma.campaign.findFirstOrThrow({ where: { id, workspaceId } });
    if (existing.status !== "draft") throw new BadRequestException("Only draft campaigns can be edited.");
    return this.prisma.campaign.update({ where: { id }, data: dto });
  }

  @Post(":id/launch")
  launch(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: LaunchCampaignDto) {
    return this.send.launch(workspaceId, id, {
      mode: dto.mode,
      scheduledAt: dto.scheduledAt,
      variables: dto.variables as ZernioBroadcastVariable[],
    });
  }

  @Post(":id/cancel")
  cancel(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.send.cancel(workspaceId, id);
  }

  @Post(":id/refresh")
  refresh(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.send.refresh(workspaceId, id);
  }

  @Delete(":id")
  async remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    const existing = await this.prisma.campaign.findFirstOrThrow({ where: { id, workspaceId } });
    if (existing.status === "scheduled" || existing.status === "running") {
      throw new BadRequestException("Cancel this campaign before deleting it.");
    }
    return this.prisma.campaign.delete({ where: { id } }).then(() => ({ ok: true }));
  }
}

@Module({
  imports: [IntegrationsModule],
  controllers: [CampaignsController],
  providers: [CampaignSendService],
})
export class CampaignsModule {}
