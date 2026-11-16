import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { AgentSettingsController } from "./agent-settings.controller";
import { AgentSettingsService } from "./agent-settings.service";

/**
 * SP-20: the customer-facing agent's configuration. The reply gate
 * (`AgentReplyGate`) is provided by IntegrationsModule, next to the reply
 * paths that consult it, so this module can import IntegrationsModule for
 * `LAgentSetupService` without a cycle. Task 2 adds the sandbox and
 * onboarding here.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [AgentSettingsController],
  providers: [AgentSettingsService],
  exports: [AgentSettingsService],
})
export class AgentModule {}
