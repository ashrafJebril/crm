import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { WorkspacesService } from "./workspaces.service";
import { PermissionService, type Actor, type EffectiveRole } from "../permissions/permission.service";
import { SYSTEM_ROLES } from "../permissions/system-roles";

const sys = (key: keyof typeof SYSTEM_ROLES) => ({
  id: `r_${key}`, workspaceId: "ws1", key, isSystem: true, name: key, nameAr: key,
  permissions: SYSTEM_ROLES[key].permissions,
});
const custom = {
  id: "r_custom", workspaceId: "ws1", key: null, isSystem: false, name: "Billing", nameAr: "x",
  permissions: { members: ["view", "update"] },
};
const mem = (over: Record<string, unknown>) => ({
  id: "m1", workspaceId: "ws1", role: "owner", roleId: "r_owner", roleRef: sys("owner"), ...over,
});
const effOf = (key: keyof typeof SYSTEM_ROLES | null, perms?: Record<string, string[]>): EffectiveRole => ({
  roleId: key ? `r_${key}` : "r_c", key, name: key ?? "c", nameAr: "x",
  permissions: (perms ?? (key ? SYSTEM_ROLES[key].permissions : {})) as never,
  conversationVisibility: "all",
});

describe("WorkspacesService member roles (SP-25)", () => {
  let prisma: any;
  let permissions: PermissionService;
  let effective: jest.Mock;
  let invalidate: jest.Mock;
  let svc: WorkspacesService;
  const owner: Actor = { userId: "actor" };

  beforeEach(() => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn().mockResolvedValue(mem({})),
        // other members of the workspace (excluding the target): one more owner by default
        findMany: jest.fn().mockResolvedValue([mem({ id: "m2", roleId: null, roleRef: null })]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "m1", ...data })),
        delete: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: "n" }),
      },
      role: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    permissions = new PermissionService(prisma);
    effective = jest.fn().mockResolvedValue(effOf("owner")); // the caller is an owner by default
    invalidate = jest.fn();
    (permissions as any).effective = effective;
    (permissions as any).invalidate = invalidate;
    (permissions as any).systemRoleRow = jest
      .fn()
      .mockImplementation((_ws: string, role: string) => Promise.resolve(sys(role as never)));
    svc = new WorkspacesService(prisma, {} as never, permissions);
  });

  describe("updateMemberRole with a legacy role string", () => {
    it("sets roleId to the matching system role and invalidates the member cache", async () => {
      const res = await svc.updateMemberRole("ws1", "u1", { role: "agent" }, owner);
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { role: "agent", roleId: "r_agent" },
      });
      expect(invalidate).toHaveBeenCalledWith("ws1", "u1");
      expect(res).toMatchObject({ role: "agent", roleId: "r_agent" });
    });

    it("clears roleId when no system role resolves (legacy fallback applies)", async () => {
      (permissions as any).systemRoleRow.mockResolvedValue(null);
      await svc.updateMemberRole("ws1", "u1", { role: "viewer" }, owner);
      expect(prisma.workspaceMember.update.mock.calls[0][0].data).toEqual({ role: "viewer", roleId: null });
    });

    it("404s an unknown member without touching cache", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(svc.updateMemberRole("ws1", "u9", { role: "agent" }, owner)).rejects.toBeInstanceOf(NotFoundException);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("a member row of another workspace -> 404 (explicit post-check)", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ workspaceId: "wsX" }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, owner)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.removeMember("ws1", "u1", owner)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it("other-workspace rows never count as another owner", async () => {
      prisma.workspaceMember.findMany.mockResolvedValue([mem({ id: "m2", workspaceId: "wsX", roleRef: null })]);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" }, owner)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("neither role nor roleId -> 400; both -> 400", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", {} as never, owner)).rejects.toBeInstanceOf(BadRequestException);
      const err: any = await svc.updateMemberRole("ws1", "u1", { role: "agent", roleId: "r_agent" }, owner).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe("Send role or roleId, not both");
    });
  });

  describe("updateMemberRole with roleId", () => {
    it("custom role assignment syncs legacy role string to agent", async () => {
      prisma.role.findFirst.mockResolvedValue(custom);
      await svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, owner);
      expect(prisma.role.findFirst).toHaveBeenCalledWith({ where: { id: "r_custom", workspaceId: "ws1" } });
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { role: "agent", roleId: "r_custom" },
      });
      expect(invalidate).toHaveBeenCalledWith("ws1", "u1");
    });

    it("system role by id syncs legacy string to its key", async () => {
      prisma.role.findFirst.mockResolvedValue(sys("admin"));
      await svc.updateMemberRole("ws1", "u1", { roleId: "r_admin" }, owner);
      expect(prisma.workspaceMember.update.mock.calls[0][0].data).toEqual({ role: "admin", roleId: "r_admin" });
    });

    it("foreign role id -> 404", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "other" }, owner)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
    });

    it("a role row from another workspace (tenancy rewrite) -> 404", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, workspaceId: "wsX" });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, owner)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("last-owner rule (inside one transaction)", () => {
    beforeEach(() => prisma.workspaceMember.findMany.mockResolvedValue([])); // m1 is the only owner

    it("demoting last owner -> 400", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" }, owner)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("moving the last owner to a custom role -> 400", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: {} });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, owner)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a member whose custom role overrides the legacy owner string is not an owner", async () => {
      prisma.workspaceMember.findMany.mockResolvedValue([mem({ id: "m2", roleId: "r_custom", roleRef: custom })]);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, owner)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("re-saving the owner role of the last owner is fine", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { role: "owner" }, owner)).resolves.toBeDefined();
    });

    it("demoting an owner is fine when another owner exists", async () => {
      prisma.workspaceMember.findMany.mockResolvedValue([mem({ id: "m2", roleId: null, roleRef: null })]);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" }, owner)).resolves.toBeDefined();
    });

    it("removing the last owner -> 400 and runs in a transaction", async () => {
      await expect(svc.removeMember("ws1", "u1", owner)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("removing a non-owner is fine and invalidates the cache", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ id: "m3", role: "agent", roleId: null, roleRef: null }));
      await expect(svc.removeMember("ws1", "u3", owner)).resolves.toEqual({ ok: true });
      expect(invalidate).toHaveBeenCalledWith("ws1", "u3");
    });
  });

  describe("cannot grant more than you hold", () => {
    const adminActor: Actor = { userId: "adm" };
    beforeEach(() => effective.mockResolvedValue(effOf("admin")));

    it("admin assigning a custom role holding billing.manage -> 403", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: { billing: ["manage"] } });
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      const err: any = await svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, adminActor).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe("Cannot grant permissions you don't have");
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
    });

    it("a custom-role manager cannot assign admin (superset of own permissions)", async () => {
      effective.mockResolvedValue(effOf(null, { members: ["view", "update"] }));
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException); // agent has contacts.*
    });

    it("admin may assign a role within its own permissions", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "viewer", roleId: null, roleRef: null }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, adminActor)).resolves.toBeDefined();
    });

    it("super-admin bypasses", async () => {
      effective.mockResolvedValue(effOf(null, {}));
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" }, { userId: "s", isSuperAdmin: true })).resolves.toBeDefined();
    });

    it("impersonation may not grant billing.* / campaigns.manage, but may grant the rest", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      const imp: Actor = { userId: "i", impersonating: true };
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: { campaigns: ["manage"] } });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, imp)).rejects.toBeInstanceOf(ForbiddenException);
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: { contacts: ["delete"] } });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, imp)).resolves.toBeDefined();
    });

    it("addMember and invite enforce the same subset rule", async () => {
      effective.mockResolvedValue(effOf(null, { members: ["create"] }));
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(svc.addMember("ws1", { userId: "u5", role: "agent" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.inviteByEmail("ws1", { email: "a@b.co", role: "admin" }, adminActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
    });
  });

  describe("owner protection", () => {
    const adminActor: Actor = { userId: "adm" };
    beforeEach(() => effective.mockResolvedValue(effOf("admin")));

    it("an admin cannot assign the owner role (roleId or role string)", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      prisma.role.findFirst.mockResolvedValue(sys("owner"));
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_owner" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "owner" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("an admin cannot change an owner's role, remove an owner, or reset an owner's password", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.removeMember("ws1", "u1", adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.resetMemberPassword("ws1", "u1", { password: "secret1" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it("an admin cannot add or invite an owner", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(svc.addMember("ws1", { userId: "u5", role: "owner" }, adminActor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.inviteByEmail("ws1", { email: "a@b.co", role: "owner" }, adminActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("an owner can assign the owner role", async () => {
      effective.mockResolvedValue(effOf("owner"));
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "owner" }, owner)).resolves.toBeDefined();
    });

    it("an admin can still manage non-owners", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "viewer", roleId: null, roleRef: null }));
      await expect(svc.removeMember("ws1", "u1", adminActor)).resolves.toEqual({ ok: true });
    });
  });

  describe("adding members by legacy role string maps to the system role", () => {
    it("addMember stores roleId", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await svc.addMember("ws1", { userId: "u5", role: "agent" }, owner);
      expect(prisma.workspaceMember.create).toHaveBeenCalledWith({
        data: { userId: "u5", workspaceId: "ws1", role: "agent", roleId: "r_agent" },
      });
    });
  });
});
