import { SkillsModule } from "../skills/skills.module";
import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { McpServerModule } from "../mcp-server/mcp-server.module";
import { AgentSettingsController } from "./agent-settings.controller";
import { AgentSettingsService } from "./agent-settings.service";
import { OnboardingController } from "./onboarding/onboarding.controller";
import { OnboardingService } from "./onboarding/onboarding.service";
import { SandboxController } from "./sandbox/sandbox.controller";
import { SandboxScheduler } from "./sandbox/sandbox.scheduler";
import { SandboxService } from "./sandbox/sandbox.service";

/**
 * SP-20: the customer-facing agent's configuration, the "Try your agent"
 * sandbox and the guided onboarding. The reply gate (`AgentReplyGate`) is
 * provided by IntegrationsModule, next to the reply paths that consult it, so
 * this module can import IntegrationsModule for `LAgentSetupService` without
 * a cycle. The sandbox builds McpServerModule's tools in sandbox mode; the
 * shared Claude client comes from AiModule (SP-21); onboarding writes through
 * KnowledgeSourcesModule's services.
 */
@Module({
  // SP-22: SkillsModule for the sandbox's enabled tools.
  imports: [IntegrationsModule, AiModule, McpServerModule, KnowledgeSourcesModule, SkillsModule],
  controllers: [AgentSettingsController, SandboxController, OnboardingController],
  providers: [AgentSettingsService, SandboxService, SandboxScheduler, OnboardingService],
  exports: [AgentSettingsService],
})
export class AgentModule {}
