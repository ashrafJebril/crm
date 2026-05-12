import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { FacebookService } from "./facebook.service";
import { ConnectFacebookDto, PublishToPageDto, ReplyToCommentDto } from "./facebook.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("integrations/facebook")
export class FacebookController {
  constructor(private readonly fb: FacebookService) {}

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
