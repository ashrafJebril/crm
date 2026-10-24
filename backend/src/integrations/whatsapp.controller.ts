import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";

@Controller()
export class WhatsAppController {
  constructor(
    private readonly wa: WhatsAppService,
    private readonly handoff: AiHandoffService,
  ) {}

  // ── Tenant-scoped endpoints ─────────────────────────────────────────────
  @Get("integrations/whatsapp/status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.wa.status(workspaceId);
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
  ) {
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
  ) {
    const res = await this.wa.sendTemplateInConversation(
      workspaceId,
      conversationId,
      dto.name,
      dto.language,
      dto.variables ?? [],
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
