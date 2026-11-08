import { ForbiddenException } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller";
import { PermissionService, type EffectiveRole } from "../permissions/permission.service";

const eff = (perms: Record<string, string[]>): EffectiveRole => ({
  roleId: "r", key: null, name: "Custom", nameAr: "x", permissions: perms as never, conversationVisibility: "all",
});

describe("WorkspacesController member routes use permissions, not legacy roles", () => {
  let svc: any;
  let perms: PermissionService;
  let effective: jest.Mock;
  let ctl: WorkspacesController;
  // legacy role of the caller is "agent" (custom roles sync to it) - must not matter
  const req = (workspaceId = "ws1") => ({ user: { sub: "u1", workspaceId } }) as never;

  beforeEach(() => {
    svc = {
      requireMember: jest.fn().mockResolvedValue("agent"),
      updateMemberRole: jest.fn().mockResolvedValue({ ok: 1 }),
      removeMember: jest.fn().mockResolvedValue({ ok: true }),
      addMember: jest.fn(),
      listMembers: jest.fn(),
    };
    perms = new PermissionService({} as never);
    effective = jest.fn();
    (perms as any).effective = effective;
    ctl = new WorkspacesController(svc, perms);
  });

  it("a custom role with members.update (legacy role agent) can change roles in the JWT workspace", async () => {
    await expect(ctl.updateMemberRole("ws1", "u2", { roleId: "r1" }, req())).resolves.toEqual({ ok: 1 });
    expect(svc.updateMemberRole).toHaveBeenCalledWith("ws1", "u2", { roleId: "r1" }, expect.objectContaining({ userId: "u1" }));
    expect(svc.requireMember).toHaveBeenCalledWith("u1", "ws1");
    expect(effective).not.toHaveBeenCalled(); // the global guard already checked
  });

  it("still requires membership of :id", async () => {
    svc.requireMember.mockRejectedValue(new ForbiddenException("Not a member of this workspace"));
    await expect(ctl.removeMember("ws1", "u2", req())).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.removeMember).not.toHaveBeenCalled();
  });

  it("for another workspace than the JWT one, the permission is evaluated on :id", async () => {
    effective.mockResolvedValue(eff({ members: ["view"] }));
    await expect(ctl.updateMemberRole("wsB", "u2", { role: "agent" }, req("ws1"))).rejects.toMatchObject({
      response: { message: "Missing permission", permission: "members.update" },
    });
    effective.mockResolvedValue(eff({ members: ["update"] }));
    await expect(ctl.updateMemberRole("wsB", "u2", { role: "agent" }, req("ws1"))).resolves.toBeDefined();
    expect(effective).toHaveBeenCalledWith("wsB", "u1");
  });
});
