import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "crypto";
import type { Response } from "express";
import { FacebookService } from "./facebook.service";
import { ConnectFacebookDto, EditPostDto, PublishToPageDto, ReplyToCommentDto } from "./facebook.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";

const OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_metadata",
  "pages_manage_engagement",
  "pages_messaging",
  "pages_read_user_content",
  "business_management",
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_manage_comments",
  "instagram_content_publish",
].join(",");

@Controller("integrations/facebook")
export class FacebookController {
  private readonly log = new Logger(FacebookController.name);
  constructor(
    private readonly fb: FacebookService,
    private readonly jwt: JwtService,
  ) {}

  private callbackUrl(): string {
    const base = process.env.BACKEND_PUBLIC_URL ?? "http://localhost:3001";
    return `${base}/api/integrations/facebook/oauth/callback`;
  }

  private frontendBase(): string {
    return process.env.FRONTEND_PUBLIC_URL ?? "http://localhost:5173";
  }

  // ── OAuth flow ──────────────────────────────────────────────────────────
  @Get("oauth/start")
  oauthStart(@CurrentWorkspace() workspaceId: string) {
    const appId = process.env.META_APP_ID;
    if (!appId) {
      return { error: "META_APP_ID is not configured on the backend" };
    }
    const nonce = randomBytes(16).toString("hex");
    const state = this.jwt.sign(
      { workspaceId, nonce, purpose: "fb_oauth" },
      { expiresIn: "10m" },
    );
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: this.callbackUrl(),
      scope: OAUTH_SCOPES,
      response_type: "code",
      state,
    });
    const url = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
    return { url };
  }

  @Public()
  @Get("oauth/callback")
  async oauthCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const frontend = this.frontendBase();
    const redirectWithStatus = (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      return res.redirect(`${frontend}/settings?${qs}`);
    };

    if (error) {
      this.log.warn(`OAuth error from Meta: ${error} — ${errorDescription}`);
      return redirectWithStatus({
        fb: "error",
        msg: errorDescription ?? error,
      });
    }
    if (!code || !state) {
      return redirectWithStatus({ fb: "error", msg: "Missing code or state" });
    }

    let workspaceId: string;
    try {
      const payload = this.jwt.verify<{ workspaceId: string; purpose: string }>(state);
      if (payload.purpose !== "fb_oauth" || !payload.workspaceId) {
        throw new Error("Bad state payload");
      }
      workspaceId = payload.workspaceId;
    } catch (e) {
      this.log.warn(`State verification failed: ${(e as Error).message}`);
      return redirectWithStatus({ fb: "error", msg: "Invalid OAuth state" });
    }

    try {
      const userToken = await this.fb.exchangeCodeForUserToken(code, this.callbackUrl());
      await this.fb.connect(workspaceId, userToken);
      return redirectWithStatus({ fb: "connected" });
    } catch (e) {
      this.log.error(`OAuth callback failed: ${(e as Error).message}`);
      return redirectWithStatus({ fb: "error", msg: (e as Error).message });
    }
  }

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.fb.status(workspaceId);
  }

  @Post("connect")
  connect(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: ConnectFacebookDto,
  ) {
    return this.fb.connect(workspaceId, dto.accessToken);
  }

  @Delete("disconnect")
  disconnect(@CurrentWorkspace() workspaceId: string) {
    return this.fb.disconnect(workspaceId);
  }

  @Get("pages")
  listPages(@CurrentWorkspace() workspaceId: string) {
    return this.fb.listPages(workspaceId);
  }

  @Post("select-page")
  selectPage(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: { pageId: string },
  ) {
    return this.fb.selectPage(workspaceId, dto.pageId);
  }

  @Get("posts")
  listPosts(@CurrentWorkspace() workspaceId: string) {
    return this.fb.listPosts(workspaceId);
  }

  @Post("posts")
  publishPost(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PublishToPageDto,
  ) {
    return this.fb.publishToPage(workspaceId, dto);
  }

  @Delete("posts/:postId")
  deletePost(
    @CurrentWorkspace() workspaceId: string,
    @Param("postId") postId: string,
  ) {
    return this.fb.deletePost(workspaceId, postId);
  }

  @Patch("posts/:postId")
  editPost(
    @CurrentWorkspace() workspaceId: string,
    @Param("postId") postId: string,
    @Body() dto: EditPostDto,
  ) {
    return this.fb.editPost(workspaceId, postId, dto.message);
  }

  @Get("posts/:postId/comments")
  listComments(
    @CurrentWorkspace() workspaceId: string,
    @Param("postId") postId: string,
  ) {
    return this.fb.listComments(workspaceId, postId);
  }

  @Post("comments/:commentId/reply")
  replyToComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("commentId") commentId: string,
    @Body() dto: ReplyToCommentDto,
  ) {
    return this.fb.replyToComment(workspaceId, commentId, dto.message);
  }

  // ── Page DMs ────────────────────────────────────────────────────────────
  @Get("conversations")
  listConversations(@CurrentWorkspace() workspaceId: string) {
    return this.fb.listConversations(workspaceId);
  }

  @Get("conversations/:conversationId/messages")
  listMessagesInConversation(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
  ) {
    return this.fb.listMessagesInConversation(workspaceId, conversationId);
  }

  @Post("conversations/:recipientId/send")
  sendDirectMessage(
    @CurrentWorkspace() workspaceId: string,
    @Param("recipientId") recipientId: string,
    @Body() dto: ReplyToCommentDto,
  ) {
    return this.fb.sendDirectMessage(workspaceId, recipientId, dto.message);
  }
}
