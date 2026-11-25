import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { PatchAgentSettingsDto } from "./agent-settings.dto";
import { AgentSettingsService } from "./agent-settings.service";

/**
 * SP-20 agent settings routes. Permissions live in permission-map.ts:
 * `GET` is `agent.view`; `PATCH` and `resync` are `agent.update`. The
 * workspace comes from the JWT; the body never names one.
 */
@Controller("agent/settings")
export class AgentSettingsController {
  constructor(private readonly svc: AgentSettingsService) {}

  @Get()
  get(@CurrentWorkspace() ws: string) {
    return this.svc.get(ws);
  }

  @Patch()
  patch(@CurrentWorkspace() ws: string, @Body() dto: PatchAgentSettingsDto) {
    return this.svc.update(ws, dto);
  }

  @Post("resync")
  resync(@CurrentWorkspace() ws: string) {
    return this.svc.resync(ws);
  }
}
