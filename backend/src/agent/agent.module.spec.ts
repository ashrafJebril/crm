import { readFileSync } from "fs";
import { join } from "path";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { IntegrationsModule } from "../integrations/integrations.module";
import { WhatsAppService } from "../integrations/whatsapp.service";
import { ZernioService } from "../integrations/zernio.service";
import { AgentReplyGate } from "./agent-reply-gate";
import { AgentSettingsController } from "./agent-settings.controller";
import { AgentSettingsService } from "./agent-settings.service";
import { AgentModule } from "./agent.module";
import { AiModule } from "../ai/ai.module";
import { McpServerModule } from "../mcp-server/mcp-server.module";
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { SandboxController } from "./sandbox/sandbox.controller";
import { SandboxService } from "./sandbox/sandbox.service";
import { SandboxScheduler } from "./sandbox/sandbox.scheduler";
import { OnboardingController } from "./onboarding/onboarding.controller";
import { OnboardingService } from "./onboarding/onboarding.service";

describe("SP-20 module wiring", () => {
  it("IntegrationsModule provides and exports the reply gate next to the reply paths", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IntegrationsModule)).toContain(AgentReplyGate);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, IntegrationsModule)).toContain(AgentReplyGate);
  });

  it("ZernioService and WhatsAppService ask Nest for the gate", () => {
    for (const cls of [ZernioService, WhatsAppService]) {
      const params = Reflect.getMetadata("design:paramtypes", cls) as unknown[];
      expect({ cls: cls.name, has: params.includes(AgentReplyGate) }).toEqual({ cls: cls.name, has: true });
    }
  });

  it("AgentModule serves the settings, sandbox and onboarding routes and is part of the app", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AgentModule)).toEqual([AgentSettingsController, SandboxController, OnboardingController]);
    for (const p of [AgentSettingsService, SandboxService, SandboxScheduler, OnboardingService]) {
      expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AgentModule)).toContain(p);
    }
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AgentModule)).toEqual(
      expect.arrayContaining([IntegrationsModule, AiModule, McpServerModule, KnowledgeSourcesModule]),
    );
    // The sandbox gets the MCP tools factory from McpServerModule.
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, McpServerModule)).toContain(McpToolsFactory);
    // AppModule itself is not loaded here (its import graph takes ~40 s); its source lists the module.
    const app = readFileSync(join(__dirname, "..", "app.module.ts"), "utf8");
    expect(app).toContain('import { AgentModule } from "./agent/agent.module";');
    expect(app).toMatch(/^\s+AgentModule,\r?$/m);
  });
});
