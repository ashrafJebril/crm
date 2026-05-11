import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { FacebookService } from "./facebook.service";
import { ConnectFacebookDto, ReplyToCommentDto } from "./facebook.dto";

@Controller("integrations/facebook")
export class FacebookController {
  constructor(private readonly fb: FacebookService) {}

  @Get("status")
  status() {
    return this.fb.status();
  }

  @Post("connect")
  connect(@Body() dto: ConnectFacebookDto) {
    return this.fb.connect(dto.accessToken);
  }

  @Delete("disconnect")
  disconnect() {
    return this.fb.disconnect();
  }

  @Get("pages")
  listPages() {
    return this.fb.listPages();
  }

  @Post("select-page")
  selectPage(@Body() dto: { pageId: string }) {
    return this.fb.selectPage(dto.pageId);
  }

  @Get("posts")
  listPosts() {
    return this.fb.listPosts();
  }

  @Get("posts/:postId/comments")
  listComments(@Param("postId") postId: string) {
    return this.fb.listComments(postId);
  }

  @Post("comments/:commentId/reply")
  replyToComment(
    @Param("commentId") commentId: string,
    @Body() dto: ReplyToCommentDto,
  ) {
    return this.fb.replyToComment(commentId, dto.message);
  }

  // ── Page DMs ────────────────────────────────────────────────────────────
  @Get("conversations")
  listConversations() {
    return this.fb.listConversations();
  }

  @Get("conversations/:conversationId/messages")
  listMessagesInConversation(@Param("conversationId") conversationId: string) {
    return this.fb.listMessagesInConversation(conversationId);
  }

  @Post("conversations/:recipientId/send")
  sendDirectMessage(
    @Param("recipientId") recipientId: string,
    @Body() dto: ReplyToCommentDto,
  ) {
    return this.fb.sendDirectMessage(recipientId, dto.message);
  }
}
