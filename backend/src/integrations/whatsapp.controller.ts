import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AiHandoffService } from "./ai-handoff.service";
import { WhatsAppService } from "./whatsapp.service";
import { MetaWebhookSignatureGuard } from "../common/meta-webhook-signature.guard";
import {
  ConnectByTokenDto,
  ConnectWhatsAppDto,
  SendWhatsAppDto,
  SendWhatsAppTemplateDto,
  TestSendWhatsAppDto,
} from "./whatsapp.dto";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { Public } from "../auth/public.decorator";

@Controller()
export class WhatsAppController {
  constructor(
    private readonly wa: WhatsAppService,
    private readonly handoff: AiHandoffService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // ── Tenant-scoped endpoints ─────────────────────────────────────────────
  /** verifyToken is a webhook credential: only channels.update holders get
   *  it, though agents/viewers may read this route (SP-19 R10). */
  @Get("integrations/whatsapp/status")
  async status(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer?: Viewer) {
    const includeVerifyToken = this.perm
      ? await this.perm.viewerCan(workspaceId, viewer, "channels.update")
      : false;
    return this.wa.status(workspaceId, { includeVerifyToken });
  }

  @Post("integrations/whatsapp/connect")
  connect(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: ConnectWhatsAppDto,
  ) {
    return this.wa.connect(workspaceId, dto);
  }

  @Post("integrations/whatsapp/connect-by-token")
  connectByToken(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: ConnectByTokenDto,
  ) {
    return this.wa.connectByToken(workspaceId, dto.accessToken);
  }

  @Post("integrations/whatsapp/oauth/exchange")
  embeddedSignup(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: { code: string; phoneNumberId: string; wabaId: string },
  ) {
    return this.wa.embeddedSignupExchange(
      workspaceId,
      dto.code,
      dto.phoneNumberId,
      dto.wabaId,
    );
  }

  @Delete("integrations/whatsapp/disconnect")
  disconnect(@CurrentWorkspace() workspaceId: string) {
    return this.wa.disconnect(workspaceId);
  }

  @Post("integrations/whatsapp/test-send")
  testSend(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: TestSendWhatsAppDto,
  ) {
    return this.wa.sendText(workspaceId, dto.to, dto.message);
  }

  @Post("integrations/whatsapp/conversations/:conversationId/send")
  async sendInConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
    @Body() dto: SendWhatsAppDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // Hidden conversation -> 404 before anything is sent.
    await this.perm?.assertConversationVisible(workspaceId, conversationId, viewer);
    const res = await this.wa.sendInConversation(
      workspaceId,
      conversationId,
      dto.message,
      dto.mediaId,
    );
    await this.handoff.humanReplied(workspaceId, conversationId);
    return res;
  }

  @Post("integrations/whatsapp/conversations/:conversationId/send-template")
  async sendTemplateInConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
    @Body() dto: SendWhatsAppTemplateDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertConversationVisible(workspaceId, conversationId, viewer);
    const res = await this.wa.sendTemplateInConversation(
      workspaceId,
      conversationId,
      dto.name,
      dto.language,
      dto.variables ?? [],
      dto.header,
      viewer,
    );
    await this.handoff.humanReplied(workspaceId, conversationId);
    return res;
  }

  // ── Public webhook (Meta calls these) ───────────────────────────────────
  @Public()
  @Get("webhooks/whatsapp")
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ) {
    return this.wa.verifyWebhook(mode, token, challenge);
  }

  @Public()
  @UseGuards(MetaWebhookSignatureGuard)
  @Post("webhooks/whatsapp")
  @HttpCode(200)
  receive(@Body() payload: unknown) {
    return this.wa.handleWebhook(payload as Parameters<WhatsAppService["handleWebhook"]>[0]);
  }
}
