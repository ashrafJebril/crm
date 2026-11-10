import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/current-workspace.decorator";
import { ChannelHealthService } from "./channel-health.service";

/**
 * SP-14 number health routes (permission-map.ts):
 * - `POST /channels/:id/health/check`: `channels.update` (ruling R4); it
 *   spends shared Zernio budget and Meta Graph quota. Reading the cached
 *   health needs only `channels.view` (it is on every ChannelDto).
 * - `GET /channels/:id/templates`: `templates.view`; the number's template
 *   snapshot, read-only and without a provider call (ruling 11(a)).
 */
@Controller("channels")
export class ChannelHealthController {
  constructor(private readonly health: ChannelHealthService) {}

  @Post(":id/health/check")
  @HttpCode(200)
  check(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.health.check(workspaceId, id, { trigger: "manual" });
  }

  @Get(":id/templates")
  templates(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.health.templates(workspaceId, id);
  }
}
