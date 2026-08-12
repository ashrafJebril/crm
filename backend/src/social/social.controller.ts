import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { SocialService } from "./social.service";
import { PublishDto } from "./social.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("social")
export class SocialController {
  constructor(private readonly svc: SocialService) {}

  @Post("publish")
  publish(@CurrentWorkspace() workspaceId: string, @Body() dto: PublishDto) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3001";
    return this.svc.publish(workspaceId, dto, publicBase);
  }

  @Get("scheduled")
  scheduled(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listScheduled(workspaceId);
  }

  @Delete("scheduled/:id")
  cancelScheduled(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.cancelScheduled(workspaceId, id);
  }
}
