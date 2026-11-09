import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/current-workspace.decorator";
import { ChannelHealthService } from "./channel-health.service";

/**
 * SP-14 live health check. `channels.update` (ruling R4; permission-map.ts):
 * it spends shared Zernio budget and Meta Graph quota. Reading the cached
 * health needs only `channels.view` (it is on every ChannelDto).
 */
@Controller("channels")
export class ChannelHealthController {
  constructor(private readonly health: ChannelHealthService) {}

  @Post(":id/health/check")
  @HttpCode(200)
  check(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.health.check(workspaceId, id, { trigger: "manual" });
  }
}
