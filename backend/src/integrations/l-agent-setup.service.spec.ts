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
      // SP-17: both sections present.
      if (path.endsWith("/prompts")) return [{ version: 2, content: "x\n<!-- kewy-crm-tools -->\n<!-- kewy-crm-photos -->" }];
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

  describe("prompt setup appends the photos section once", () => {
    const withPrompt = (content: string) =>
      client.request.mockImplementation(async (path: string) => {
        if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
        if (path.endsWith("/prompts")) return [{ version: 1, content }];
        return undefined;
      });
    const puts = () => client.request.mock.calls.filter(([, o]: any[]) => o?.method === "PUT");

    it("no section: one PUT with both markers, tools first", async () => {
      withPrompt("You are support.");
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      expect(content.startsWith("You are support.\n\n<!-- kewy-crm-tools -->")).toBe(true);
      expect(content.indexOf("<!-- kewy-crm-tools -->")).toBeLessThan(content.indexOf("<!-- kewy-crm-photos -->"));
      expect(content).toContain("list_photos");
      expect(content.split("<!-- kewy-crm-photos -->")).toHaveLength(2);
    });

    it("tools marker only: one PUT adding the photos section, the rest kept", async () => {
      const before = "You are support.\n\n<!-- kewy-crm-tools -->\n## Booking";
      withPrompt(before);
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      expect(content.startsWith(`${before}\n\n<!-- kewy-crm-photos -->`)).toBe(true);
      expect(content.split("<!-- kewy-crm-tools -->")).toHaveLength(2);
    });

    it("both present: no PUT, already-present", async () => {
      withPrompt("x <!-- kewy-crm-photos --> y <!-- kewy-crm-tools -->");
      expect((await svc.ensure("ws-1")).prompt).toBe("already-present");
      expect(puts()).toHaveLength(0);
    });

    it("an empty prompt gets both sections without a leading blank line", async () => {
      withPrompt("");
      await svc.ensure("ws-1");
      expect(puts()[0][1].body.content.startsWith("<!-- kewy-crm-tools -->")).toBe(true);
    });

    it("a new registration describes approved photos", async () => {
      await svc.ensure("ws-1");
      expect(mcp.create.mock.calls[0][1].description).toContain("approved photos");
    });
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
