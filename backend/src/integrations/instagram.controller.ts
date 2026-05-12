import { Body, Controller, Get, Post } from "@nestjs/common";
import { InstagramService } from "./instagram.service";
import { PublishToIgDto } from "./instagram.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("integrations/instagram")
export class InstagramController {
  constructor(private readonly svc: InstagramService) {}

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.svc.status(workspaceId);
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
}
