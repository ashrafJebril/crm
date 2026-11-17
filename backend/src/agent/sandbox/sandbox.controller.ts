import { Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { IsString } from "class-validator";
import { CurrentUserId, CurrentWorkspace } from "../../common/current-workspace.decorator";
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
  send(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() dto: SandboxMessageDto) {
    return this.svc.send(ws, userId, dto.message);
  }

  @Delete()
  reset(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string) {
    return this.svc.reset(ws, userId);
  }
}
