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
import { IsOptional, IsString } from "class-validator";
import { ZernioService } from "./zernio.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";
import { ZernioWebhookSignatureGuard } from "../common/zernio-webhook-signature.guard";

class ZernioSendDto {
  @IsString() accountId!: string;
  @IsString() message!: string;
}

/** Reply into one of our own DB conversations — the accountId is resolved
 *  server-side from the conversation's channel, so the client needn't know it. */
class ZernioDbSendDto {
  @IsString() message!: string;
}

class ZernioCommentReplyDto {
  @IsString() message!: string;
  @IsOptional() @IsString() accountId?: string;
}

class ZernioPostCommentDto {
  @IsString() message!: string;
  @IsString() accountId!: string;
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

  @Get("integrations/zernio/posts")
  posts(@CurrentWorkspace() workspaceId: string, @Query("platform") platform?: string) {
    return this.zernio.listPosts(workspaceId, platform);
  }

  @Get("integrations/zernio/comments")
  comments(@CurrentWorkspace() workspaceId: string, @Query("platform") platform?: string) {
    return this.zernio.listComments(workspaceId, platform);
  }

  @Post("integrations/zernio/comments/:id/reply")
  replyToComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioCommentReplyDto,
  ) {
    return this.zernio.replyToComment(workspaceId, id, dto.message, dto.accountId);
  }

  /** Top-level comment on one of the workspace's own posts (no parent comment). */
  @Post("integrations/zernio/posts/:postId/comments")
  commentOnPost(
    @CurrentWorkspace() workspaceId: string,
    @Param("postId") postId: string,
    @Body() dto: ZernioPostCommentDto,
  ) {
    return this.zernio.commentOnPost(workspaceId, postId, dto.message, dto.accountId);
  }

  @Delete("integrations/zernio/comments/:id")
  deleteComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("accountId") accountId?: string,
  ) {
    return this.zernio.deleteComment(workspaceId, id, accountId);
  }

  @Get("integrations/zernio/conversations")
  conversations(
    @CurrentWorkspace() workspaceId: string,
    @Query("platform") platform?: string,
  ) {
    return this.zernio.listConversations(workspaceId, platform);
  }

  @Get("integrations/zernio/conversations/:id/messages")
  messages(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("accountId") accountId?: string,
  ) {
    return this.zernio.getMessages(workspaceId, id, accountId);
  }

  @Post("integrations/zernio/conversations/:id/send")
  send(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioSendDto,
  ) {
    return this.zernio.sendInConversation(workspaceId, id, dto.accountId, dto.message);
  }

  /** One-time import of Zernio conversation history into our DB (idempotent). */
  @Post("integrations/zernio/backfill")
  backfill(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.backfillHistory(workspaceId);
  }

  @Post("integrations/zernio/db-conversations/:id/send")
  sendInDbConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioDbSendDto,
  ) {
    return this.zernio.sendInDbConversation(workspaceId, id, dto.message);
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
