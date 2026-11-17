import { MODULE_METADATA } from "@nestjs/common/constants";
import { SkillsModule } from "./skills.module";
import { SkillsService } from "./skills.service";
import { AgentPromptService } from "./agent-prompt.service";
import { AgentToolCallRecorder } from "./agent-tool-call.recorder";
import { AgentToolCallPruneScheduler } from "./agent-tool-call-prune.scheduler";
import { CONNECTOR_PRESENCE } from "./connector-presence";
import { ConnectorPresenceModule } from "../connectors/connector-presence.module";
import { ConnectorPresenceService } from "../connectors/connector-presence.service";
import { SkillsController } from "./skills.controller";
import { IntegrationsModule } from "../integrations/integrations.module";
import { McpServerModule } from "../mcp-server/mcp-server.module";
import { McpServerController } from "../mcp-server/mcp-server.controller";
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { TicketsModule } from "../tickets/tickets.module";
import { TicketsService } from "../tickets/tickets.service";
import { TagsModule, TagsService } from "../tags/tags.module";
import { PrismaService } from "../prisma/prisma.service";
import { AgentModule } from "../agent/agent.module";
import { SandboxService } from "../agent/sandbox/sandbox.service";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-skills-module-spec-0123456789";

const meta = (key: string, target: object) => Reflect.getMetadata(key, target) as unknown[];
const params = (cls: object) => Reflect.getMetadata("design:paramtypes", cls) as unknown[];

describe("SP-22 module wiring", () => {
  it("SkillsModule serves the routes, binds the real connector presence (SP-23) and exports what the MCP server needs", () => {
    expect(meta(MODULE_METADATA.CONTROLLERS, SkillsModule)).toEqual([SkillsController]);
    expect(meta(MODULE_METADATA.IMPORTS, SkillsModule)).toContain(IntegrationsModule);
    const providers = meta(MODULE_METADATA.PROVIDERS, SkillsModule);
    for (const p of [SkillsService, AgentPromptService, AgentToolCallRecorder, AgentToolCallPruneScheduler]) expect(providers).toContain(p);
    // SP-23: the presence comes from the leaf ConnectorPresenceModule (no cycle).
    expect(meta(MODULE_METADATA.IMPORTS, SkillsModule)).toContain(ConnectorPresenceModule);
    expect(meta(MODULE_METADATA.IMPORTS, ConnectorPresenceModule) ?? []).toEqual([]);
    expect(meta(MODULE_METADATA.PROVIDERS, ConnectorPresenceModule)).toContainEqual({ provide: CONNECTOR_PRESENCE, useExisting: ConnectorPresenceService });
    expect(meta(MODULE_METADATA.EXPORTS, SkillsModule)).toEqual(expect.arrayContaining([SkillsService, AgentToolCallRecorder, ConnectorPresenceModule]));
  });

  it("the MCP server reads the enabled skills and gets the new tools' services", () => {
    expect(meta(MODULE_METADATA.IMPORTS, McpServerModule)).toEqual(expect.arrayContaining([SkillsModule, TicketsModule, TagsModule]));
    expect(params(McpServerController)).toContain(SkillsService);
    expect(params(McpToolsFactory)).toEqual(expect.arrayContaining([TicketsService, TagsService, PrismaService, AgentToolCallRecorder]));
  });

  it("the sandbox builds the same enabled tools", () => {
    expect(meta(MODULE_METADATA.IMPORTS, AgentModule)).toContain(SkillsModule);
    expect(params(SandboxService)).toContain(SkillsService);
  });

  it("SkillsModule is part of the app", async () => {
    const { AppModule } = await import("../app.module");
    expect(meta(MODULE_METADATA.IMPORTS, AppModule)).toContain(SkillsModule);
  });
});
