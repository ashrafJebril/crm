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
import { IsArray, IsOptional, IsString } from "class-validator";
import { ZernioService } from "./zernio.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";
import { ZernioWebhookSignatureGuard } from "../common/zernio-webhook-signature.guard";

class ZernioSendDto {
  @IsString() accountId!: string;
  @IsString() message!: string;
}

class ZernioPublishDto {
  @IsString() content!: string;
  @IsArray() @IsString({ each: true }) platforms!: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) mediaUrls?: string[];
}

@Controller()
export class ZernioController {
  constructor(private readonly zernio: ZernioService) {}

  // ── Tenant-scoped ────────────────────────────────────────────────────────
  @Get("integrations/zernio/status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.status(workspaceId);
  }

  /** Returns the hosted OAuth URL for the customer to authenticate through. */
  @Get("integrations/zernio/connect/:platform")
  connect(@CurrentWorkspace() workspaceId: string, @Param("platform") platform: string) {
    return this.zernio.getConnectUrl(workspaceId, platform);
  }

  /** Reconcile connected accounts (called by the frontend after the redirect). */
  @Post("integrations/zernio/sync")
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.syncAccounts(workspaceId);
  }

  @Get("integrations/zernio/whatsapp/numbers")
  whatsappNumbers(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.whatsappNumbers(workspaceId);
  }

  @Get("integrations/zernio/conversations")
  conversations(
    @CurrentWorkspace() workspaceId: string,
    @Query("platform") platform?: string,
  ) {
    return this.zernio.listConversations(workspaceId, platform);
  }

  @Get("integrations/zernio/conversations/:id/messages")
  messages(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.zernio.getMessages(workspaceId, id);
  }

  @Post("integrations/zernio/conversations/:id/send")
  send(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioSendDto,
  ) {
    return this.zernio.sendInConversation(workspaceId, id, dto.accountId, dto.message);
  }

  @Post("integrations/zernio/publish")
  publish(@CurrentWorkspace() workspaceId: string, @Body() dto: ZernioPublishDto) {
    return this.zernio.publish(workspaceId, {
      content: dto.content,
      platforms: dto.platforms,
      mediaUrls: dto.mediaUrls,
    });
  }

  @Delete("integrations/zernio/:platform")
  disconnect(@CurrentWorkspace() workspaceId: string, @Param("platform") platform: string) {
    return this.zernio.disconnect(workspaceId, platform);
  }

  // ── Public webhook (Zernio calls this) ─────────────────────────────────
  @Public()
  @UseGuards(ZernioWebhookSignatureGuard)
  @Post("webhooks/zernio")
  @HttpCode(200)
  receive(@Body() payload: unknown) {
    return this.zernio.handleEvent(
      payload as Parameters<ZernioService["handleEvent"]>[0],
    );
  }
}
