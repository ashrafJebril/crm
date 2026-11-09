import { Body, Controller, Get, HttpCode, Optional, Param, Post } from "@nestjs/common";
import { CurrentViewer, CurrentWorkspace } from "../../common/current-workspace.decorator";
import { PermissionService } from "../../permissions/permission.service";
import type { Viewer } from "../../permissions/visibility";
import { WhatsAppService } from "../../integrations/whatsapp.service";
import { ChannelsService } from "../channels.service";
import type { ChannelDto } from "../channel-dto";
import {
  EmbeddedSignupDto,
  LandlineNumberDto,
  LandlineRequestCodeDto,
  LandlineVerifyDto,
  ManualWhatsappDto,
} from "../channels.dto";
import { EmbeddedSignupService, embeddedSignupConfig, type EmbeddedSignupConfigDto } from "./embedded-signup.service";
import { LandlineService } from "./landline.service";

/** `POST /channels/whatsapp/manual` response. */
export interface ManualWhatsappResult {
  channel: ChannelDto;
  /** false when Meta refused to subscribe our app to the WABA (no inbound
   *  until a reconnect succeeds). */
  webhookSubscribed: boolean;
  /** The token's WABAs and numbers (ids and names only), for a picker. */
  discovered: unknown;
}

/**
 * SP-19 T4 — WhatsApp add flows and landline verification.
 * Permissions (permission-map.ts): config → channels.view; embedded signup
 * and manual connect → channels.create; landline steps → channels.update.
 * Nothing here reads conversation data. A foreign channel id is 404.
 */
@Controller()
export class WhatsappChannelsController {
  constructor(
    private readonly signupSvc: EmbeddedSignupService,
    private readonly landline: LandlineService,
    private readonly wa: WhatsAppService,
    private readonly channels: ChannelsService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** Whether the embedded signup is available; `missing` env names only for
   *  channels.update holders. Never returns the app secret. */
  @Get("channels/whatsapp/embedded-signup/config")
  async config(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer?: Viewer): Promise<EmbeddedSignupConfigDto> {
    const canManage = this.perm ? await this.perm.viewerCan(workspaceId, viewer, "channels.update") : false;
    return embeddedSignupConfig({ includeMissing: canManage });
  }

  @Post("channels/whatsapp/embedded-signup")
  signup(@CurrentWorkspace() workspaceId: string, @Body() dto: EmbeddedSignupDto): Promise<ChannelDto> {
    return this.signupSvc.signup(workspaceId, dto);
  }

  @Post("channels/whatsapp/manual")
  async manual(@CurrentWorkspace() workspaceId: string, @Body() dto: ManualWhatsappDto): Promise<ManualWhatsappResult> {
    const res = await this.wa.connectByToken(workspaceId, dto.accessToken, {
      phoneNumberId: dto.phoneNumberId,
      errorStyle: "keys",
      // The hub's "Add number": a token's not-yet-held number is added.
      add: true,
    });
    return {
      channel: await this.channels.get(workspaceId, res.channelId),
      webhookSubscribed: res.webhookSubscribed,
      discovered: res.discovered,
    };
  }

  @Post("channels/:id/landline/number")
  @HttpCode(200)
  landlineNumber(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: LandlineNumberDto) {
    return this.landline.addNumber(workspaceId, id, dto);
  }

  @Post("channels/:id/landline/request-code")
  @HttpCode(200)
  landlineRequestCode(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: LandlineRequestCodeDto) {
    return this.landline.requestCode(workspaceId, id, dto);
  }

  @Post("channels/:id/landline/verify")
  @HttpCode(200)
  landlineVerify(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: LandlineVerifyDto) {
    return this.landline.verify(workspaceId, id, dto);
  }

  @Post("channels/:id/landline/register")
  @HttpCode(200)
  landlineRegister(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.landline.register(workspaceId, id);
  }
}
