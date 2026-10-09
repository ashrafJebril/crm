import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpTokenService } from "../integrations/mcp-token.service";

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

describe("McpAuthGuard", () => {
  let tokens: { findWorkspaceByToken: jest.Mock };
  let guard: McpAuthGuard;

  beforeEach(() => {
    tokens = { findWorkspaceByToken: jest.fn() };
    guard = new McpAuthGuard(tokens as unknown as McpTokenService);
  });

  it("attaches workspaceId to req.user for a valid token", async () => {
    tokens.findWorkspaceByToken.mockResolvedValue("ws1");
    const req: { headers: Record<string, string>; user?: unknown } = {
      headers: { authorization: "Bearer mcp_abc_def" },
    };
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.user).toEqual({ sub: "mcp-server", email: "", role: "admin", workspaceId: "ws1" });
    expect(tokens.findWorkspaceByToken).toHaveBeenCalledWith("mcp_abc_def");
  });

  it("rejects a missing Authorization header", async () => {
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const req = { headers: { authorization: "Basic xyz" } };
    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an unknown or revoked token", async () => {
    tokens.findWorkspaceByToken.mockResolvedValue(null);
    const req = { headers: { authorization: "Bearer mcp_bad_token" } };
    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
