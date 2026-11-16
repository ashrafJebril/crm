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

  it("AgentModule serves the settings routes and is part of the app", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AgentModule)).toEqual([AgentSettingsController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AgentModule)).toContain(AgentSettingsService);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AgentModule)).toContain(IntegrationsModule);
    // AppModule itself is not loaded here (its import graph takes ~40 s); its source lists the module.
    const app = readFileSync(join(__dirname, "..", "app.module.ts"), "utf8");
    expect(app).toContain('import { AgentModule } from "./agent/agent.module";');
    expect(app).toMatch(/^\s+AgentModule,\r?$/m);
  });
});
