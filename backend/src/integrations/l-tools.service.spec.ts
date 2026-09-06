import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LToolsService } from "./l-tools.service";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { PrismaService } from "../prisma/prisma.service";

const TOOL = {
  id: "tool-1", name: "weather", description: "d", method: "GET",
  url_template: "https://x/{city}", enabled: true, created_at: "2026-09-06T00:00:00Z",
  params: ["city"],
};

describe("LToolsService", () => {
  let svc: LToolsService;
  let prisma: any;
  let client: any;
  let resolver: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LToolsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
        { provide: LAgentResolverService, useValue: resolver },
      ],
    }).compile();
    svc = moduleRef.get(LToolsService);
  });

  it("lists tools for a connected workspace", async () => {
    client.request.mockResolvedValue([TOOL]);
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: true, tools: [TOOL] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools");
  });

  it("returns connected:false when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    expect(await svc.list("ws-1")).toEqual({ connected: false, tools: [] });
  });

  it("creates a tool", async () => {
    client.request.mockResolvedValue(TOOL);
    const input = { name: "weather", description: "d", method: "GET", url_template: "https://x/{city}" };
    const result = await svc.create("ws-1", input);
    expect(result).toEqual(TOOL);
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools", { method: "POST", body: input });
  });

  it("deletes a tool", async () => {
    await svc.remove("ws-1", "tool-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools/tool-1", { method: "DELETE" });
  });

  it("binds a tool to the resolved agent slug", async () => {
    await svc.bind("ws-1", "tool-1");
    expect(resolver.resolveSlug).toHaveBeenCalledWith("ws-1", "l-ws-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/tools/tool-1", { method: "PUT" },
    );
  });

  it("unbinds a tool from the resolved agent slug", async () => {
    await svc.unbind("ws-1", "tool-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/tools/tool-1", { method: "DELETE" },
    );
  });

  it("throws when binding on an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.bind("ws-1", "tool-1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(resolver.resolveSlug).not.toHaveBeenCalled();
  });
});
