import { McpServerController } from "./mcp-server.controller";

jest.mock("@mastra/mcp", () => ({
  MCPServer: jest.fn().mockImplementation(() => ({ startHTTP: jest.fn().mockResolvedValue(undefined) })),
}));

function build() {
  const toolsFactory = { build: jest.fn().mockReturnValue({}) };
  const skills = { enabledFor: jest.fn().mockResolvedValue(new Set(["crm_core"])) };
  const controller = new McpServerController(toolsFactory as never, skills as never);
  const req = (headers: Record<string, string>) =>
    ({ url: "/api/mcp/v1", protocol: "https", get: () => "crm.example.com", headers }) as never;
  return { controller, toolsFactory, req };
}

describe("McpServerController dry run", () => {
  it("serves the sandbox tools when l marks the turn as a test", async () => {
    const { controller, toolsFactory, req } = build();
    await controller.handle(req({ "x-kewy-dry-run": "1" }), {} as never, "ws-1");
    expect(toolsFactory.build).toHaveBeenCalledWith("ws-1", expect.objectContaining({ mode: "sandbox" }));
  });

  it("serves the live tools on an ordinary turn", async () => {
    const { controller, toolsFactory, req } = build();
    await controller.handle(req({}), {} as never, "ws-1");
    expect(toolsFactory.build).toHaveBeenCalledWith("ws-1", expect.objectContaining({ mode: "live" }));
  });

  it("does not treat any other value as a test", async () => {
    const { controller, toolsFactory, req } = build();
    await controller.handle(req({ "x-kewy-dry-run": "0" }), {} as never, "ws-1");
    expect(toolsFactory.build).toHaveBeenCalledWith("ws-1", expect.objectContaining({ mode: "live" }));
  });

  it("keeps the enabled-skills filter in a test", async () => {
    const { controller, toolsFactory, req } = build();
    await controller.handle(req({ "x-kewy-dry-run": "1" }), {} as never, "ws-1");
    const opts = toolsFactory.build.mock.calls[0][1];
    expect([...opts.enabled]).toEqual(["crm_core"]);
  });
});
