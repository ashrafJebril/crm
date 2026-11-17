import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { AgentPromptService } from "./agent-prompt.service";
import { AgentToolCallPruneScheduler } from "./agent-tool-call-prune.scheduler";
import { AgentToolCallRecorder } from "./agent-tool-call.recorder";
import { ConnectorPresenceModule } from "../connectors/connector-presence.module";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";

/**
 * SP-22 skills gallery. SP-23: CONNECTOR_PRESENCE comes from the leaf
 * ConnectorPresenceModule (real Connector rows; it imports nothing, so
 * ConnectorsModule can import this module without a cycle). McpServerModule
 * imports this module for `enabledFor` and the tool-call recorder.
 */
@Module({
  imports: [IntegrationsModule, ConnectorPresenceModule],
  controllers: [SkillsController],
  providers: [
    SkillsService,
    AgentPromptService,
    AgentToolCallRecorder,
    AgentToolCallPruneScheduler,
  ],
  exports: [SkillsService, AgentPromptService, AgentToolCallRecorder, ConnectorPresenceModule],
})
export class SkillsModule {}
