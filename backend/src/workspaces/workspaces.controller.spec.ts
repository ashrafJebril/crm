import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller";

describe("WorkspacesController member routes use permissions, not legacy roles", () => {
  let svc: any;
  let ctl: WorkspacesController;
  // legacy role of the caller is "viewer" (custom roles sync to it) - must not matter
  const req = (workspaceId = "ws1") => ({ user: { sub: "u1", workspaceId } }) as never;

  beforeEach(() => {
    svc = {
      requireMember: jest.fn().mockResolvedValue("agent"),
      updateMemberRole: jest.fn().mockResolvedValue({ ok: 1 }),
      removeMember: jest.fn().mockResolvedValue({ ok: true }),
      addMember: jest.fn(),
      listMembers: jest.fn(),
    };
    ctl = new WorkspacesController(svc);
  });

  it("a custom role with members.update (legacy role agent) can change roles in the JWT workspace", async () => {
    await expect(ctl.updateMemberRole("ws1", "u2", { roleId: "r1" }, req())).resolves.toEqual({ ok: 1 });
    expect(svc.updateMemberRole).toHaveBeenCalledWith("ws1", "u2", { roleId: "r1" }, expect.objectContaining({ userId: "u1" }));
    expect(svc.requireMember).toHaveBeenCalledWith("u1", "ws1");
  });

  it("still requires membership of :id", async () => {
    svc.requireMember.mockRejectedValue(new ForbiddenException("Not a member of this workspace"));
    await expect(ctl.removeMember("ws1", "u2", req())).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.removeMember).not.toHaveBeenCalled();
  });

  it("for another workspace than the JWT one, every member/settings route is a 400 'switch first'", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => ctl.update("wsB", {} as never, req("ws1")),
      () => ctl.listMembers("wsB", req("ws1")),
      () => ctl.addMember("wsB", { userId: "u2", role: "agent" }, req("ws1")),
      () => ctl.invite("wsB", { email: "a@b.co", role: "agent" }, req("ws1")),
      () => ctl.updateMemberRole("wsB", "u2", { role: "agent" }, req("ws1")),
      () => ctl.resetMemberPassword("wsB", "u2", { password: "secret1" }, req("ws1")),
      () => ctl.removeMember("wsB", "u2", req("ws1")),
    ];
    for (const call of calls) {
      const err: any = await call().catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe("Switch to this workspace first");
    }
    for (const fn of ["updateMemberRole", "removeMember", "addMember", "listMembers"]) expect(svc[fn]).not.toHaveBeenCalled();
  });

  it("a super-admin may still target another workspace", async () => {
    const r = { user: { sub: "s", workspaceId: "ws1", isSuperAdmin: true } } as never;
    await expect(ctl.updateMemberRole("wsB", "u2", { role: "agent" }, r)).resolves.toEqual({ ok: 1 });
  });
});
