import { LAgentSetupService } from "./l-agent-setup.service";

describe("LAgentSetupService", () => {
  let svc: LAgentSetupService;
  let prisma: any;
  let client: any;
  let resolver: any;
  let mcp: any;
  let tokens: any;

  beforeEach(() => {
    prisma = { raw: { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-1" }) } } };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };
    mcp = {
      list: jest.fn().mockResolvedValue({ connected: true, servers: [] }),
      create: jest.fn().mockResolvedValue({ id: "srv-1" }),
      bind: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      status: jest.fn().mockResolvedValue({ connected: false }),
      generate: jest.fn().mockResolvedValue({ token: "mcp_abc_secret", endpointUrl: "http://crm/api/mcp/v1" }),
    };
    client.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
      if (path.endsWith("/prompts")) return [{ version: 1, content: "You are support." }];
      return undefined;
    });
    svc = new LAgentSetupService(prisma, client, resolver, mcp, tokens);
  });

  it("registers the CRM MCP server with a bearer token, binds it, and extends the prompt", async () => {
    const result = await svc.ensure("ws-1");

    expect(result).toEqual({ mcpServer: "created", prompt: "updated" });
    expect(mcp.create).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        name: "kewy_crm",
        url: "http://crm/api/mcp/v1",
        headers: { Authorization: "Bearer mcp_abc_secret" },
      }),
    );
    expect(mcp.bind).toHaveBeenCalledWith("ws-1", "srv-1");
    const put = client.request.mock.calls.find(([, o]: any[]) => o?.method === "PUT");
    expect(put[0]).toBe("/workspaces/l-1/agents/customer-support/prompt");
    expect(put[1].body.content).toContain("You are support.");
    expect(put[1].body.content).toContain("create_appointment");
  });

  it("is a no-op when the server, token and prompt are already in place", async () => {
    mcp.list.mockResolvedValue({ connected: true, servers: [{ id: "srv-1", name: "kewy_crm" }] });
    tokens.status.mockResolvedValue({ connected: true });
    client.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 2 }];
      if (path.endsWith("/prompts")) return [{ version: 2, content: "x\n<!-- kewy-crm-tools -->" }];
      return undefined;
    });

    const result = await svc.ensure("ws-1");

    expect(result).toEqual({ mcpServer: "already-present", prompt: "already-present" });
    expect(tokens.generate).not.toHaveBeenCalled();
    expect(mcp.create).not.toHaveBeenCalled();
    expect(client.request.mock.calls.some(([, o]: any[]) => o?.method === "PUT")).toBe(false);
  });

  it("re-registers with a fresh token when the CRM token was revoked", async () => {
    mcp.list.mockResolvedValue({ connected: true, servers: [{ id: "old", name: "kewy_crm" }] });

    await svc.ensure("ws-1");

    expect(mcp.remove).toHaveBeenCalledWith("ws-1", "old");
    expect(tokens.generate).toHaveBeenCalled();
  });

  it("refuses a workspace that is not linked to Kewy AI", async () => {
    prisma.raw.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.ensure("ws-1")).rejects.toThrow("not linked");
  });

  it("ensureQuietly swallows failures", async () => {
    prisma.raw.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.ensureQuietly("ws-1")).resolves.toBeUndefined();
  });
});
