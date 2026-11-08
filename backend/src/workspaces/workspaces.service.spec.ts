import { NotFoundException } from "@nestjs/common";
import { WorkspacesService } from "./workspaces.service";

describe("WorkspacesService.updateMemberRole (SP-25 roleId sync)", () => {
  let prisma: any;
  let permissions: { systemRoleId: jest.Mock; invalidate: jest.Mock };
  let svc: WorkspacesService;

  beforeEach(() => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn().mockResolvedValue({ id: "m1", role: "owner", roleId: "r_owner" }),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "m1", ...data })),
      },
    };
    permissions = { systemRoleId: jest.fn().mockResolvedValue("r_agent"), invalidate: jest.fn() };
    svc = new WorkspacesService(prisma, {} as never, permissions as never);
  });

  it("sets roleId to the matching system role and invalidates the member's cache", async () => {
    const res = await svc.updateMemberRole("ws1", "u1", { role: "agent" });
    expect(permissions.systemRoleId).toHaveBeenCalledWith("ws1", "agent");
    expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { role: "agent", roleId: "r_agent" },
    });
    expect(permissions.invalidate).toHaveBeenCalledWith("ws1", "u1");
    expect(res).toMatchObject({ role: "agent", roleId: "r_agent" });
  });

  it("clears roleId when no system role resolves (legacy fallback applies)", async () => {
    permissions.systemRoleId.mockResolvedValue(null);
    await svc.updateMemberRole("ws1", "u1", { role: "viewer" });
    expect(prisma.workspaceMember.update.mock.calls[0][0].data).toEqual({ role: "viewer", roleId: null });
  });

  it("404s an unknown member without touching roles or cache", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(svc.updateMemberRole("ws1", "u9", { role: "agent" })).rejects.toBeInstanceOf(NotFoundException);
    expect(permissions.systemRoleId).not.toHaveBeenCalled();
    expect(permissions.invalidate).not.toHaveBeenCalled();
  });
});
