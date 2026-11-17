/* eslint-disable @typescript-eslint/no-explicit-any */
import { MODULE_METADATA } from "@nestjs/common/constants";
import { readFileSync } from "fs";
import { join } from "path";
import { CopilotModule } from "./copilot.module";
import { COPILOT_REGISTRY } from "./copilot-turn.service";
import { CopilotController } from "./copilot.controller";

describe("CopilotModule", () => {
  const providers: any[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CopilotModule);
  const registry = providers.find((p) => p?.provide === COPILOT_REGISTRY);

  it("is wired into the app with its controller", () => {
    // (AppModule itself needs the full environment to load; its source lists the module.)
    const app = readFileSync(join(__dirname, "..", "app.module.ts"), "utf8");
    expect(app).toContain('import { CopilotModule } from "./copilot/copilot.module";');
    expect(app.split(/\r?\n/).map((l) => l.trim())).toContain("CopilotModule,");
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CopilotModule)).toEqual([CopilotController]);
  });

  it("the registry: knowledge and insights are optional (tools absent without them)", () => {
    expect(registry.inject.slice(-3).map((i: any) => i.optional)).toEqual([true, true, true]);
    const stub = {} as any;
    const without = registry.useFactory(stub, stub, stub, stub, stub, stub, stub, stub, undefined, undefined, undefined);
    expect(without.names()).not.toContain("search_knowledge");
    expect(without.names()).not.toContain("summarize_insights");
    expect(without.names()).not.toContain("save_attachment_to_knowledge");
    expect(without.names()).toEqual(expect.arrayContaining(["create_activity", "move_ticket_stage"]));
    const withBoth = registry.useFactory(stub, stub, stub, stub, stub, stub, stub, stub, { search: jest.fn() }, { support: jest.fn() }, { uploadFiles: jest.fn() });
    expect(withBoth.names()).toEqual(expect.arrayContaining(["search_knowledge", "summarize_insights", "save_attachment_to_knowledge"]));
  });
});
