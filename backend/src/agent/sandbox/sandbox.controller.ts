import { Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { IsString } from "class-validator";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../../common/current-workspace.decorator";
import type { Viewer } from "../../permissions/visibility";
import { SandboxService } from "./sandbox.service";

/** Length and emptiness are checked in the service (400 `agent.message_invalid`). */
export class SandboxMessageDto {
  @IsString() message!: string;
}

/**
 * SP-20 "Try your agent". Every route is `agent.update` (a turn costs money,
 * ruling 9). The thread is the caller's own (workspace and member from the
 * JWT); no route takes a thread, member or workspace id.
 */
@Controller("agent/sandbox")
export class SandboxController {
  constructor(private readonly svc: SandboxService) {}

  @Get()
  get(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string) {
    return this.svc.get(ws, userId);
  }

  @Post("messages")
  send(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Body() dto: SandboxMessageDto) {
    return this.svc.send(ws, viewer.userId, dto.message, new Date(), { bypass: viewer.bypass });
  }

  @Delete()
  reset(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string) {
    return this.svc.reset(ws, userId);
  }
}
