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
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { TemplateHeaderDto } from "./whatsapp.dto";
import { AiHandoffService } from "./ai-handoff.service";
import { ZernioService } from "./zernio.service";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { Public } from "../auth/public.decorator";
import { ZernioWebhookSignatureGuard } from "../common/zernio-webhook-signature.guard";
import { staffSenderId } from "../conversations/message-sender";

class ZernioSendDto {
  @IsString() accountId!: string;
  @IsString() message!: string;
}

/** Reply into one of our own DB conversations — the accountId is resolved
 *  server-side from the conversation's channel, so the client needn't know it.
 *  mediaId attaches an image/video from the media library (message may then
 *  be empty — the attachment satisfies the platform's content requirement). */
class ZernioDbSendDto {
  @IsString() message!: string;
  @IsOptional() @IsString() mediaId?: string;
}

/** Send an approved WhatsApp template into one of our DB conversations. The
 *  accountId is resolved server-side from the conversation's channel, same as
 *  ZernioDbSendDto. `variables` fill the template's {{1}}, {{2}} … in order. */
class ZernioDbSendTemplateDto {
  @IsString() name!: string;
  @IsString() language!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) variables?: string[];
  /** SP-31 header values (library media id, or text params). */
  @IsOptional() @ValidateNested() @Type(() => TemplateHeaderDto) header?: TemplateHeaderDto;
}

class ZernioCommentReplyDto {
  @IsString() message!: string;
  @IsOptional() @IsString() accountId?: string;
}

class ZernioPostCommentDto {
  @IsString() message!: string;
  @IsString() accountId!: string;
}

/** Comment auto-reply rule. Saving this NEVER starts anything — the rule only
 *  reaches Zernio when it is explicitly enabled. */
class CommentRuleDto {
  @IsString() accountId!: string;
  @IsArray() @IsString({ each: true }) keywords!: string[];
  @IsString() dmMessage!: string;
  @IsOptional() @IsIn(["contains", "word", "exact"]) matchMode?: "contains" | "word" | "exact";
  @IsOptional() @IsString() platformPostId?: string | null;
  @IsOptional() @IsString() commentReply?: string | null;
  @IsOptional() @IsBoolean() replyOncePerPerson?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(86400) dmDelaySeconds?: number;
  @IsOptional() @IsBoolean() handoffToAgent?: boolean;
}

@Controller()
export class ZernioController {
  constructor(
    private readonly zernio: ZernioService,
    private readonly handoff: AiHandoffService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // ── Tenant-scoped ────────────────────────────────────────────────────────
  @Get("integrations/zernio/status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.status(workspaceId);
  }

  /** Returns the hosted OAuth URL for the customer to authenticate through. */
  @Get("integrations/zernio/connect/:platform")
  connect(
    @CurrentWorkspace() workspaceId: string,
    @Param("platform") platform: string,
    // SP-19 T5 (I1): the hub's Reconnect names the held channel it re-authorises.
    @Query("reconnectChannelId") reconnectChannelId?: string,
  ) {
    return this.zernio.getConnectUrl(workspaceId, platform, {
      reconnectChannelId: typeof reconnectChannelId === "string" && reconnectChannelId ? reconnectChannelId : undefined,
    });
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

  @Get("integrations/zernio/import-status")
  importStatus(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.importStatus(workspaceId);
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

  // ── Comment auto-reply ───────────────────────────────────────────────────
  //
  // Save and enable are deliberately SEPARATE routes. Saving is free; enabling
  // creates an automation at Zernio that starts DMing real people and keeps
  // running independently of this app, so it must be its own explicit act.

  @Get("integrations/zernio/comment-rules")
  commentRules(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.listCommentRules(workspaceId);
  }

  @Post("integrations/zernio/comment-rules")
  saveCommentRule(@CurrentWorkspace() workspaceId: string, @Body() dto: CommentRuleDto) {
    return this.zernio.saveCommentRule(workspaceId, dto);
  }

  @Post("integrations/zernio/comment-rules/:id/enable")
  @HttpCode(200)
  enableCommentRule(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.zernio.enableCommentRule(workspaceId, id);
  }

  @Post("integrations/zernio/comment-rules/:id/disable")
  @HttpCode(200)
  disableCommentRule(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.zernio.disableCommentRule(workspaceId, id);
  }

  @Delete("integrations/zernio/comment-rules/:id")
  deleteCommentRule(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.zernio.deleteCommentRule(workspaceId, id);
  }

  @Get("integrations/zernio/conversations")
  async conversations(
    @CurrentWorkspace() workspaceId: string,
    @Query("platform") platform?: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // Provider-live threads cannot be matched to assignees: empty for
    // assigned-only members.
    if (await this.perm?.isConversationRestricted(workspaceId, viewer)) return [];
    return this.zernio.listConversations(workspaceId, platform);
  }

  @Get("integrations/zernio/conversations/:id/messages")
  async messages(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("accountId") accountId?: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertNotRestricted(workspaceId, viewer);
    return this.zernio.getMessages(workspaceId, id, accountId);
  }

  @Post("integrations/zernio/conversations/:id/send")
  async send(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioSendDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertNotRestricted(workspaceId, viewer);
    return this.zernio.sendInConversation(workspaceId, id, dto.accountId, dto.message);
  }

  /** One-time import of Zernio conversation history into our DB (idempotent). */
  @Post("integrations/zernio/backfill")
  backfill(@CurrentWorkspace() workspaceId: string) {
    return this.zernio.backfillHistory(workspaceId);
  }

  /** Import ONE conversation's Zernio history on demand (the Inbox calls it
   *  when a Zernio thread opens empty). Idempotent and throttled per
   *  conversation; same scope as GET /conversations/:id. */
  @Post("integrations/zernio/db-conversations/:id/import-history")
  @HttpCode(200)
  async importHistory(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // Hidden conversation -> 404 before Zernio is asked for anything.
    await this.perm?.assertConversationVisible(workspaceId, id, viewer);
    return this.zernio.importHistoryForConversation(workspaceId, id);
  }

  @Post("integrations/zernio/db-conversations/:id/send")
  async sendInDbConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioDbSendDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // Hidden conversation -> 404 before anything is sent.
    await this.perm?.assertConversationVisible(workspaceId, id, viewer);
    const publicBase =
      process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3001";
    const res = await this.zernio.sendInDbConversation(
      workspaceId,
      id,
      dto.message,
      dto.mediaId,
      publicBase,
      "human",
      undefined,
      staffSenderId(viewer),
    );
    await this.handoff.humanReplied(workspaceId, id);
    return res;
  }

  @Post("integrations/zernio/db-conversations/:id/send-template")
  async sendTemplateInDbConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioDbSendTemplateDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertConversationVisible(workspaceId, id, viewer);
    const res = await this.zernio.sendTemplateInDbConversation(
      workspaceId,
      id,
      dto.name,
      dto.language,
      dto.variables ?? [],
      dto.header,
      viewer,
      staffSenderId(viewer),
    );
    await this.handoff.humanReplied(workspaceId, id);
    return res;
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
