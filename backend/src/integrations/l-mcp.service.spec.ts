import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LMcpService } from "./l-mcp.service";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { PrismaService } from "../prisma/prisma.service";

const SERVER = {
  id: "srv-1", name: "docs", description: "d", url: "https://mcp.example.com/mcp",
  enabled: true, last_checked_at: null, last_error: null, created_at: "2026-09-06T00:00:00Z",
};

describe("LMcpService", () => {
  let svc: LMcpService;
  let prisma: any;
  let client: any;
  let resolver: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
        { provide: LAgentResolverService, useValue: resolver },
      ],
    }).compile();
    svc = moduleRef.get(LMcpService);
  });

  it("lists servers for a connected workspace", async () => {
    client.request.mockResolvedValue([SERVER]);
    expect(await svc.list("ws-1")).toEqual({ connected: true, servers: [SERVER] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers");
  });

  it("returns connected:false when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    expect(await svc.list("ws-1")).toEqual({ connected: false, servers: [] });
  });

  it("creates a server", async () => {
    client.request.mockResolvedValue(SERVER);
    const input = { name: "docs", description: "d", url: "https://mcp.example.com/mcp" };
    expect(await svc.create("ws-1", input)).toEqual(SERVER);
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers", { method: "POST", body: input });
  });

  it("deletes a server", async () => {
    await svc.remove("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers/srv-1", { method: "DELETE" });
  });

  it("binds a server to the resolved agent slug", async () => {
    await svc.bind("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/mcp-servers/srv-1", { method: "PUT" },
    );
  });

  it("unbinds a server from the resolved agent slug", async () => {
    await svc.unbind("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/mcp-servers/srv-1", { method: "DELETE" },
    );
  });

  it("tests a server", async () => {
    client.request.mockResolvedValue({ ok: true, tools: ["echo"], error: null });
    const result = await svc.test("ws-1", "srv-1");
    expect(result).toEqual({ ok: true, tools: ["echo"], error: null });
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/mcp-servers/srv-1/test", { method: "POST" },
    );
  });

  it("throws when creating on an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(
      svc.create("ws-1", { name: "docs", description: "d", url: "https://x" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
