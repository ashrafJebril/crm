import { Body, Controller, Post } from "@nestjs/common";
import { SocialService } from "./social.service";
import { PublishDto } from "./social.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("social")
export class SocialController {
  constructor(private readonly svc: SocialService) {}

  @Post("publish")
  publish(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PublishDto,
  ) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.publishNow(workspaceId, dto, publicBase);
  }
}
