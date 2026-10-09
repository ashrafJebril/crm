import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { McpTokenController } from "./mcp-token.controller";
import { McpTokenService } from "./mcp-token.service";
import { WorkspacesService } from "../workspaces/workspaces.service";

describe("McpTokenController", () => {
  let controller: McpTokenController;
  let tokens: { status: jest.Mock; generate: jest.Mock; revoke: jest.Mock };
  let workspaces: { requireMember: jest.Mock };

  beforeEach(async () => {
    tokens = {
      status: jest.fn().mockResolvedValue({ connected: false }),
      generate: jest.fn().mockResolvedValue({ token: "mcp_x_y", endpointUrl: "http://x/api/mcp/v1" }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    workspaces = { requireMember: jest.fn().mockResolvedValue("owner") };

    const moduleRef = await Test.createTestingModule({
      controllers: [McpTokenController],
      providers: [
        { provide: McpTokenService, useValue: tokens },
        { provide: WorkspacesService, useValue: workspaces },
      ],
    }).compile();
    controller = moduleRef.get(McpTokenController);
  });

  it("returns status without requiring an editor role", async () => {
    await expect(controller.status("ws1")).resolves.toEqual({ connected: false });
    expect(workspaces.requireMember).not.toHaveBeenCalled();
  });

  it("lets an owner generate a token", async () => {
    await expect(controller.generate("ws1", "u1")).resolves.toEqual({
      token: "mcp_x_y",
      endpointUrl: "http://x/api/mcp/v1",
    });
    expect(tokens.generate).toHaveBeenCalledWith("ws1");
  });

  it("lets an admin revoke a token", async () => {
    workspaces.requireMember.mockResolvedValue("admin");
    await expect(controller.revoke("ws1", "u1")).resolves.toEqual({ ok: true });
    expect(tokens.revoke).toHaveBeenCalledWith("ws1");
  });

  it("blocks a non-editor role from generating a token", async () => {
    workspaces.requireMember.mockResolvedValue("agent");
    await expect(controller.generate("ws1", "u1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.generate).not.toHaveBeenCalled();
  });

  it("blocks a non-editor role from revoking a token", async () => {
    workspaces.requireMember.mockResolvedValue("viewer");
    await expect(controller.revoke("ws1", "u1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });
});
