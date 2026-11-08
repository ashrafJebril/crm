import { Body, Controller, Delete, Get, Optional, Param, Patch, Post } from "@nestjs/common";
import { AiHandoffService } from "./ai-handoff.service";
import { InstagramService } from "./instagram.service";
import { EditIgCaptionDto, PublishToIgDto } from "./instagram.dto";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";

@Controller("integrations/instagram")
export class InstagramController {
  constructor(
    private readonly svc: InstagramService,
    private readonly handoff: AiHandoffService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.svc.status(workspaceId);
  }

  @Post("sync")
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.svc.syncConversations(workspaceId);
  }

  @Get("conversations")
  async listConversations(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer?: Viewer) {
    // Provider-live threads cannot be matched to assignees: empty for
    // assigned-only members.
    if (await this.perm?.isConversationRestricted(workspaceId, viewer)) return [];
    return this.svc.listConversations(workspaceId);
  }

  @Get("conversations/:conversationId/messages")
  async listMessages(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertNotRestricted(workspaceId, viewer);
    return this.svc.listMessagesInConversation(workspaceId, conversationId);
  }

  @Post("conversations/by-igsid/:igsid/send")
  async sendDirectMessage(
    @CurrentWorkspace() workspaceId: string,
    @Param("igsid") igsid: string,
    @Body() dto: { message: string; mediaId?: string },
    @CurrentViewer() viewer?: Viewer,
  ) {
    await this.perm?.assertNotRestricted(workspaceId, viewer);
    return this.svc.sendDirectMessage(
      workspaceId,
      igsid,
      dto.message,
      dto.mediaId,
    );
  }

  @Post("conversations/:conversationId/send")
  async send(
    @CurrentWorkspace() workspaceId: string,
    @Param("conversationId") conversationId: string,
    @Body() dto: { message: string; mediaId?: string },
    @CurrentViewer() viewer?: Viewer,
  ) {
    // DB conversation id: an assigned member may reply to their own thread.
    await this.perm?.assertConversationVisible(workspaceId, conversationId, viewer);
    const res = await this.svc.sendInConversation(
      workspaceId,
      conversationId,
      dto.message,
      dto.mediaId,
    );
    await this.handoff.humanReplied(workspaceId, conversationId);
    return res;
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
