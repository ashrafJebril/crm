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
  Req,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { MediaModule } from "../media/media.module";
import { MediaService } from "../media/media.service";
import type { Viewer } from "../permissions/visibility";
import { IntegrationsModule } from "../integrations/integrations.module";
import type { ZernioBroadcastVariable } from "../integrations/zernio.client";
import { CampaignSendService } from "./campaign-send.service";
import { CampaignTrackingModule } from "./tracking/campaign-tracking.module";
import { SegmentsModule } from "../segments/segments.module";
import { TagsModule } from "../tags/tags.module";
import { CampaignReportController } from "./campaign-report.controller";
import { CampaignReportService } from "./campaign-report.service";
import { CampaignFollowUpService } from "./campaign-follow-up.service";
import { campaignError } from "./campaign-errors";
import { CampaignPreviewService } from "./sending/campaign-preview.service";
import { effectiveSenderIds, normalizeSenderWrite } from "./sending/senders";
import { validateVarMapShape } from "./sending/var-map";
import { campaignSenderOptions, campaignSenders } from "../channels/default-channel";
import { assertRequestPermission, type PermissionRequest } from "../permissions/permission.guard";

class CreateCampaignDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() audience!: string;
  @IsString() @IsNotEmpty() channel!: string;
  @IsOptional() @IsString() schedule?: string;
  @IsOptional() @IsInt() @Min(0) recipients?: number;
  @IsOptional() @IsString() segmentId?: string;
  @IsOptional() @IsString() templateId?: string;
  /** SP-19: an active Zernio WhatsApp channel; null/absent = the default number. */
  @IsOptional() @IsString() senderChannelId?: string | null;
  /** SP-13: the sending numbers in order ([0] = primary); [] = the default number. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) senderChannelIds?: string[];
  /** SP-13: {"1": {source, key?, value?, fallback?}}; the shape is checked by validateVarMapShape. */
  @IsOptional() @IsObject() varMap?: Record<string, unknown> | null;
  /** SP-13: a library file overriding the template's header sample; null clears it. */
  @IsOptional() @IsString() headerMediaId?: string | null;
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
  /** SP-19: an active Zernio WhatsApp channel; null/absent = the default number. */
  @IsOptional() @IsString() senderChannelId?: string | null;
  /** SP-13: see CreateCampaignDto. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) senderChannelIds?: string[];
  @IsOptional() @IsObject() varMap?: Record<string, unknown> | null;
  @IsOptional() @IsString() headerMediaId?: string | null;
}

/** SP-13 `POST /campaigns/preview`: the draft as the builder holds it (nothing is saved). */
class PreviewCampaignDto {
  @IsOptional() @IsString() segmentId?: string | null;
  @IsOptional() @IsString() templateId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) senderChannelIds?: string[];
  @IsOptional() @IsString() senderChannelId?: string | null;
  @IsOptional() @IsObject() varMap?: Record<string, unknown> | null;
  @IsOptional() @IsString() headerMediaId?: string | null;
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
  /** Legacy only (SP-13): campaigns with a stored varMap need none. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BroadcastVariableDto)
  variables?: BroadcastVariableDto[];
}

type SendingFieldsDto = Pick<UpdateCampaignDto, "senderChannelIds" | "senderChannelId" | "varMap" | "headerMediaId">;

@Controller("campaigns")
export class CampaignsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly send: CampaignSendService,
    private readonly previewer: CampaignPreviewService,
    private readonly media: MediaService,
  ) {}

  /**
   * SP-13 sender, varMap and header fields of a create/update body ->
   * Prisma data. Senders go through `normalizeSenderWrite` (senderChannelId
   * is always the primary) and `campaignSenders` (each an active Zernio
   * WhatsApp channel of this workspace, within the plan limit). The varMap
   * is checked for shape only (the template may still change). The header
   * file goes through `MediaService.get` with the viewer (404 when foreign,
   * unknown or invisible to an assigned-only member). Absent fields are not
   * touched. Everything is validated before anything is written.
   */
  private async sendingFields(workspaceId: string, dto: SendingFieldsDto, viewer?: Viewer) {
    const data: {
      senderChannelIds?: string[];
      senderChannelId?: string | null;
      varMap?: Prisma.InputJsonValue | typeof Prisma.DbNull;
      headerMediaId?: string | null;
    } = {};
    const senders = normalizeSenderWrite({ senderChannelIds: dto.senderChannelIds, senderChannelId: dto.senderChannelId });
    if (senders) {
      await campaignSenders(this.prisma, workspaceId, senders.senderChannelIds);
      data.senderChannelIds = senders.senderChannelIds;
      data.senderChannelId = senders.senderChannelId;
    }
    if (dto.varMap !== undefined) {
      data.varMap = dto.varMap === null ? Prisma.DbNull : (validateVarMapShape(dto.varMap) as unknown as Prisma.InputJsonValue);
    }
    if (dto.headerMediaId !== undefined) {
      if (dto.headerMediaId) await this.media.get(workspaceId, dto.headerMediaId, viewer);
      data.headerMediaId = dto.headerMediaId || null;
    }
    return data;
  }

  /** The draft's own columns (everything but the SP-13 sending fields). */
  private plainFields<T extends SendingFieldsDto>(dto: T): Omit<T, keyof SendingFieldsDto> {
    const { senderChannelIds: _a, senderChannelId: _b, varMap: _c, headerMediaId: _d, ...rest } = dto;
    return rest;
  }

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

  /**
   * SP-13: the WhatsApp numbers a campaign can send from, with eligibility
   * and the plan limit (campaigns.view; no channels.view needed).
   */
  @Get("senders")
  senders(@CurrentWorkspace() workspaceId: string) {
    return campaignSenderOptions(this.prisma, workspaceId);
  }

  /**
   * SP-13 review step: reach, per-number split, missing values, transport,
   * template per number and real-contact samples (those only with
   * contacts.view, ruling 18). Writes nothing; declared before :id.
   */
  @Post("preview")
  previewV2(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PreviewCampaignDto,
    @Req() req: PermissionRequest,
    @CurrentViewer() viewer?: Viewer,
  ) {
    let canViewContacts = true;
    try {
      assertRequestPermission(req, "contacts.view");
    } catch {
      canViewContacts = false;
    }
    return this.previewer.preview(workspaceId, dto, { canViewContacts, viewer });
  }

  /**
   * One campaign of this workspace (404 campaigns.not_found otherwise), with
   * its senders `{channelId, displayName, phoneNumber}[]` in order (the
   * default number when none is chosen; a deleted channel is absent).
   */
  @Get(":id")
  async get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw campaignError("campaigns.not_found");
    const ids = effectiveSenderIds(campaign);
    const select = { id: true, displayName: true, phoneNumber: true } as const;
    let rows: Array<{ id: string; displayName: string; phoneNumber: string | null }>;
    if (ids.length > 0) {
      const found = await this.prisma.channel.findMany({ where: { workspaceId, id: { in: ids } }, select });
      const byId = new Map(found.map((c) => [c.id, c]));
      rows = ids.flatMap((i) => (byId.has(i) ? [byId.get(i)!] : []));
    } else {
      const def = await this.prisma.channel.findFirst({
        where: { workspaceId, kind: "whatsapp", provider: "zernio", status: { notIn: ["disconnected", "pending"] } },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
        select,
      });
      rows = def ? [def] : [];
    }
    return {
      ...campaign,
      senders: rows.map((c) => ({ channelId: c.id, displayName: c.displayName, phoneNumber: c.phoneNumber ?? null })),
    };
  }

  @Post()
  async create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateCampaignDto, @CurrentViewer() viewer?: Viewer) {
    const sending = await this.sendingFields(workspaceId, dto, viewer);
    return this.prisma.campaign.create({
      data: {
        ...this.plainFields(dto),
        ...sending,
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
    @CurrentViewer() viewer?: Viewer,
  ) {
    const existing = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!existing) throw campaignError("campaigns.not_found");
    if (existing.status !== "draft") throw new BadRequestException("Only draft campaigns can be edited.");
    const sending = await this.sendingFields(workspaceId, dto, viewer);
    return this.prisma.campaign.update({ where: { id }, data: { ...this.plainFields(dto), ...sending } });
  }

  @Post(":id/launch")
  launch(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: LaunchCampaignDto) {
    return this.send.launch(workspaceId, id, {
      mode: dto.mode,
      scheduledAt: dto.scheduledAt,
      variables: dto.variables as ZernioBroadcastVariable[] | undefined,
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
    const existing = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!existing) throw campaignError("campaigns.not_found");
    if (existing.status === "scheduled" || existing.status === "running") {
      throw new BadRequestException("Cancel this campaign before deleting it.");
    }
    return this.prisma.campaign.delete({ where: { id } }).then(() => ({ ok: true }));
  }
}

@Module({
  // SP-12: SegmentsModule (MarketingOutboundService) and TagsModule (TagsService) for follow-ups.
  // SP-13: MediaModule (MediaService.get for header media, with viewer visibility).
  imports: [IntegrationsModule, CampaignTrackingModule, SegmentsModule, TagsModule, MediaModule],
  // CampaignsController first, so its literal GET preview is registered before any :id route.
  controllers: [CampaignsController, CampaignReportController],
  providers: [CampaignSendService, CampaignReportService, CampaignFollowUpService, CampaignPreviewService],
})
export class CampaignsModule {}
