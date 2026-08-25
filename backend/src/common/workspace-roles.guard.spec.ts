import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { WorkspaceRolesGuard } from "./workspace-roles.guard";
import { PrismaService } from "../prisma/prisma.service";

describe("WorkspaceRolesGuard", () => {
  let guard: WorkspaceRolesGuard;
  let prisma: { workspaceMember: { findUnique: jest.Mock } };
  let reflector: { getAllAndOverride: jest.Mock };

  function makeContext(user?: Record<string, unknown>): ExecutionContext {
    const request = { user };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    prisma = { workspaceMember: { findUnique: jest.fn() } };
    reflector = { getAllAndOverride: jest.fn() };
    guard = new WorkspaceRolesGuard(
      prisma as unknown as PrismaService,
      reflector as unknown as Reflector,
    );
  });

  it("allows without a DB call when no roles metadata is present", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext({ sub: "u_1", workspaceId: "ws_1" });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("allows super-admins without checking membership", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner", "admin"]);
    const ctx = makeContext({ sub: "u_1", workspaceId: "ws_1", isSuperAdmin: true });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("allows a member with an allowed role", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner", "admin"]);
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "admin" });
    const ctx = makeContext({ sub: "u_1", workspaceId: "ws_1" });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { userId_workspaceId: { userId: "u_1", workspaceId: "ws_1" } },
    });
  });

  it("throws ForbiddenException when the member's role is not allowed", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner", "admin"]);
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "viewer" });
    const ctx = makeContext({ sub: "u_1", workspaceId: "ws_1" });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when there is no member row", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner", "admin"]);
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    const ctx = makeContext({ sub: "u_1", workspaceId: "ws_1" });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("throws UnauthorizedException when there is no user", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner"]);
    const ctx = makeContext(undefined);

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedException when the user has no workspaceId", async () => {
    reflector.getAllAndOverride.mockReturnValue(["owner"]);
    const ctx = makeContext({ sub: "u_1" });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });
});
