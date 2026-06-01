import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { InstagramService } from "./instagram.service";
import { EditIgCaptionDto, PublishToIgDto } from "./instagram.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("integrations/instagram")
export class InstagramController {
  constructor(private readonly svc: InstagramService) {}

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.svc.status(workspaceId);
  }

  @Post("sync")
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.svc.syncConversations(workspaceId);
  }

  @Get("conversations")
  listConversations(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listConversations(workspaceId);
  }

  @Get("conversations/:conversationId/messages")
  listMessages(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
  ) {
    return this.svc.listMessagesInConversation(workspaceId, conversationId);
  }

  @Post("conversations/by-igsid/:igsid/send")
  sendDirectMessage(
    @CurrentWorkspace() workspaceId: string,
    @Param("igsid") igsid: string,
    @Body() dto: { message: string },
  ) {
    return this.svc.sendDirectMessage(workspaceId, igsid, dto.message);
  }

  @Post("conversations/:conversationId/send")
  send(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
    @Body() dto: { message: string },
  ) {
    return this.svc.sendInConversation(workspaceId, conversationId, dto.message);
  }

  @Get("posts")
  listPosts(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listPosts(workspaceId);
  }

  @Get("posts/:mediaId/comments")
  listComments(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
  ) {
    return this.svc.listComments(workspaceId, mediaId);
  }

  @Post("posts/:mediaId/comments")
  commentOnMedia(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
    @Body() dto: { message: string },
  ) {
    return this.svc.commentOnMedia(workspaceId, mediaId, dto.message);
  }

  @Delete("comments/:commentId")
  deleteComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("commentId") commentId: string,
  ) {
    return this.svc.deleteComment(workspaceId, commentId);
  }

  @Post("posts")
  publish(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PublishToIgDto,
  ) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.publish(workspaceId, dto, publicBase);
  }

  @Delete("posts/:mediaId")
  deletePost(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
  ) {
    return this.svc.deletePost(workspaceId, mediaId);
  }

  @Patch("posts/:mediaId")
  editCaption(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
    @Body() dto: EditIgCaptionDto,
  ) {
    return this.svc.editCaption(workspaceId, mediaId, dto.caption);
  }
}
