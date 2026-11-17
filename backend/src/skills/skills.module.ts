import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { AgentPromptService } from "./agent-prompt.service";
import { AgentToolCallPruneScheduler } from "./agent-tool-call-prune.scheduler";
import { AgentToolCallRecorder } from "./agent-tool-call.recorder";
import { CONNECTOR_PRESENCE, NeverConnected } from "./connector-presence";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";

/**
 * SP-22 skills gallery. CONNECTOR_PRESENCE is bound to NeverConnected until
 * SP-23 rebinds it. McpServerModule imports this module for `enabledFor`
 * and the tool-call recorder.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [SkillsController],
  providers: [
    SkillsService,
    AgentPromptService,
    AgentToolCallRecorder,
    AgentToolCallPruneScheduler,
    { provide: CONNECTOR_PRESENCE, useClass: NeverConnected },
  ],
  exports: [SkillsService, AgentPromptService, AgentToolCallRecorder, CONNECTOR_PRESENCE],
})
export class SkillsModule {}
