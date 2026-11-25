import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { streamCsv } from "../common/csv-stream";
import { assertRequestPermission, type PermissionRequest } from "../permissions/permission.guard";
import { CampaignFollowUpService } from "./campaign-follow-up.service";
import {
  AddToGroupDto,
  CreateGroupDto,
  ExportBodyDto,
  ExportQueryDto,
  RecipientsQueryDto,
  TagFollowUpDto,
} from "./campaign-report.dto";
import { CampaignReportService } from "./campaign-report.service";

/**
 * SP-12 campaign detail routes. Permissions (permission-map.ts):
 * - recipients, insights: campaigns.view
 * - export (GET and POST): contacts.manage, plus campaigns.view asserted here
 * - follow-up/create-group: audiences.create; add-to-group: audiences.update;
 *   tag: contacts.update
 * Every handler loads the campaign scoped by workspace first: a foreign id
 * is 404 `campaigns.not_found`.
 */
@Controller("campaigns")
export class CampaignReportController {
  constructor(
    private readonly report: CampaignReportService,
    private readonly followUp: CampaignFollowUpService,
  ) {}

  @Get(":id/recipients")
  recipients(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Query() q: RecipientsQueryDto) {
    return this.report.recipients(workspaceId, id, {
      status: q.status,
      cursor: q.cursor,
      limit: q.limit === undefined ? undefined : Number(q.limit),
    });
  }

  @Get(":id/insights")
  insights(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.report.insights(workspaceId, id);
  }

  /** Streams the whole campaign, or one outcome. */
  @Get(":id/export")
  async exportGet(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query() q: ExportQueryDto,
    @Res() res: Response,
    @Req() req: PermissionRequest,
  ) {
    assertRequestPermission(req, "campaigns.view");
    const job = await this.report.prepareExport(workspaceId, id, { status: q.status, lang: q.lang });
    await streamCsv(res, job);
  }

  /** Same export with the ticked rows in a JSON body (up to 10 000 ids). */
  @Post(":id/export")
  async exportPost(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() body: ExportBodyDto,
    @Res() res: Response,
    @Req() req: PermissionRequest,
  ) {
    assertRequestPermission(req, "campaigns.view");
    const job = await this.report.prepareExport(workspaceId, id, {
      status: body?.status,
      ids: body?.ids,
      lang: body?.lang,
    });
    await streamCsv(res, job);
  }

  @Post(":id/follow-up/create-group")
  createGroup(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: CreateGroupDto) {
    return this.followUp.createGroup(workspaceId, id, dto);
  }

  @Post(":id/follow-up/add-to-group")
  addToGroup(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: AddToGroupDto) {
    return this.followUp.addToGroup(workspaceId, id, dto);
  }

  @Post(":id/follow-up/tag")
  tag(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: TagFollowUpDto) {
    return this.followUp.tag(workspaceId, id, dto);
  }
}
