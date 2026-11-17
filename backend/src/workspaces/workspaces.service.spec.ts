import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { WorkspacesService } from "./workspaces.service";
import { PermissionService, type Actor, type EffectiveRole } from "../permissions/permission.service";
import { SYSTEM_ROLES } from "../permissions/system-roles";
import { AuditService } from "../audit/audit.service";
import { HandoverService } from "../members/handover.service";

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
/** SP-26: removal returns what moved; nothing here holds open work. */
const NO_WORK = { conversations: 0, tickets: { deals: 0, leads: 0, support: 0 }, followUps: 0, contacts: 0, bookings: 0, total: 0 };
const removed = { ok: true, moved: NO_WORK };
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
      // SP-26: removal counts open work (none here) and writes an audit row.
      conversation: { count: jest.fn().mockResolvedValue(0) },
      ticket: { count: jest.fn().mockResolvedValue(0) },
      activity: { count: jest.fn().mockResolvedValue(0) },
      contact: { count: jest.fn().mockResolvedValue(0) },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    permissions = new PermissionService(prisma);
    effective = jest.fn().mockResolvedValue(effOf("owner")); // the caller is an owner by default
    invalidate = jest.fn();
    (permissions as any).effective = effective;
    (permissions as any).invalidate = invalidate;
    (permissions as any).systemRoleRow = jest
      .fn()
      .mockImplementation((_ws: string, role: string) => Promise.resolve(sys(role as never)));
    const audit = new AuditService(prisma);
    const handover = new HandoverService(prisma, permissions, audit, { notify: jest.fn() } as never, { emitToWorkspace: jest.fn() } as never);
    svc = new WorkspacesService(prisma, {} as never, permissions, audit, handover);
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

    it("a missing system role row is checked against SYSTEM_ROLES, never an empty grant", async () => {
      // e.g. the tenancy extension rewrote the role lookup to another workspace
      (permissions as any).systemRoleRow.mockResolvedValue(null);
      effective.mockResolvedValue(effOf(null, { members: ["view", "update"] }));
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "viewer", roleId: null, roleRef: null }));
      const err: any = await svc.updateMemberRole("ws1", "u1", { role: "admin" }, { userId: "c" }).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe("Cannot grant permissions you don't have");
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(svc.addMember("ws1", { userId: "u5", role: "admin" }, { userId: "c" })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
      expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
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
    it("custom role assignment syncs legacy role string to viewer (least privilege if the role goes)", async () => {
      prisma.role.findFirst.mockResolvedValue(custom);
      await svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, owner);
      expect(prisma.role.findFirst).toHaveBeenCalledWith({ where: { id: "r_custom", workspaceId: "ws1" } });
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { role: "viewer", roleId: "r_custom" },
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
      await expect(svc.removeMember("ws1", "u3", owner)).resolves.toEqual(removed);
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

  describe("visibility cannot be widened", () => {
    const assigned: Actor = { userId: "asg" };
    beforeEach(() => {
      effective.mockResolvedValue({ ...effOf("owner"), conversationVisibility: "assigned" });
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
    });

    it("an assigned-only caller cannot assign a role whose visibility is all", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: {}, conversationVisibility: "all" });
      const err: any = await svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, assigned).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe("Cannot grant permissions you don't have");
    });

    it("an assigned-only caller may assign an assigned role", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, permissions: {}, conversationVisibility: "assigned" });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" }, assigned)).resolves.toBeDefined();
    });
  });

  describe("serialization failures", () => {
    it("P2034 on role change or removal -> 409 try again", async () => {
      prisma.$transaction.mockRejectedValue(Object.assign(new Error("tx"), { code: "P2034" }));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" }, owner)).rejects.toBeInstanceOf(ConflictException);
      const err: any = await svc.removeMember("ws1", "u1", owner).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/try again/);
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
      await expect(svc.removeMember("ws1", "u1", adminActor)).resolves.toEqual(removed);
    });
  });

  describe("cannot act on a member with more access (assertCanActOn)", () => {
    const actor: Actor = { userId: "actor" };
    const MSG = "You can't change a member with more access than you";
    // effective() answers per user: the actor and the target (u1) differ.
    const roles = (a: EffectiveRole, t: EffectiveRole) =>
      effective.mockImplementation((_ws: string, uid: string) => Promise.resolve(uid === "actor" ? a : t));
    const managerOnly = effOf(null, { members: ["view", "update", "delete"] });
    beforeEach(() => {
      prisma.workspaceMember.findUnique.mockResolvedValue(mem({ role: "agent", roleId: null, roleRef: null }));
    });

    it("a members-only manager cannot reset the password of, re-role, or remove an agent", async () => {
      roles(managerOnly, effOf("agent"));
      for (const run of [
        () => svc.resetMemberPassword("ws1", "u1", { password: "secret1" }, actor),
        () => svc.updateMemberRole("ws1", "u1", { role: "viewer" }, actor),
        () => svc.removeMember("ws1", "u1", actor),
      ]) {
        const err: any = await run().catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.message).toBe(MSG);
      }
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it("checks the target's CURRENT role, before the change", async () => {
      // admin target being demoted to viewer: the viewer grant would pass, the current admin role does not
      roles(effOf(null, { ...SYSTEM_ROLES.viewer.permissions, members: ["view", "update"] } as never), effOf("admin"));
      await expect(svc.updateMemberRole("ws1", "u1", { role: "viewer" }, actor)).rejects.toThrow(MSG);
    });

    it("an assigned-only actor cannot act on a member who sees all conversations", async () => {
      roles({ ...effOf("admin"), conversationVisibility: "assigned" }, effOf("viewer"));
      await expect(svc.removeMember("ws1", "u1", actor)).rejects.toThrow(MSG);
    });

    it("a subset target is fine (admin over agent)", async () => {
      roles(effOf("admin"), effOf("agent"));
      await expect(svc.removeMember("ws1", "u1", actor)).resolves.toEqual(removed);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "viewer" }, actor)).resolves.toBeDefined();
    });

    it("an effective owner and a super-admin may act on anyone", async () => {
      roles(effOf("owner"), effOf("admin"));
      await expect(svc.removeMember("ws1", "u1", actor)).resolves.toEqual(removed);
      roles(effOf(null, {}), effOf("admin"));
      await expect(svc.removeMember("ws1", "u1", { userId: "s", isSuperAdmin: true })).resolves.toEqual(removed);
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

describe("inviteByEmail never changes an existing user's password", () => {
  let prisma: any;
  let kewySync: any;
  let svc: WorkspacesService;
  const actor: Actor = { userId: "actor" };
  const existingUser = { id: "u9", email: "a@b.co", name: "Ann", password: "old-hash" };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existingUser),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
        update: jest.fn(),
        delete: jest.fn(),
      },
      workspaceMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: "mem" }),
      },
    };
    kewySync = { passwordReset: jest.fn(), userCreated: jest.fn().mockResolvedValue(undefined) };
    const permissions = new PermissionService(prisma);
    (permissions as any).effective = jest.fn().mockResolvedValue(effOf("owner"));
    (permissions as any).systemRoleRow = jest
      .fn()
      .mockImplementation((_ws: string, role: string) => Promise.resolve(sys(role as never)));
    svc = new WorkspacesService(prisma, kewySync, permissions, { record: jest.fn() } as never, {} as never);
  });

  it("invite of an existing member -> 409 and no password write", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ id: "m" });
    await expect(
      svc.inviteByEmail("ws1", { email: "a@b.co", role: "agent", password: "hacked1" } as never, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(kewySync.passwordReset).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
  });

  it("invite of an existing non-member user does not change their password", async () => {
    const res = await svc.inviteByEmail("ws1", { email: "a@b.co", role: "agent", password: "hacked1" } as never, actor);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(kewySync.passwordReset).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.create).toHaveBeenCalled();
    expect(res.tempPassword).toBeUndefined();
    expect(res.created).toBe(false);
  });

  it("invite of a new user still sets the password", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await svc.inviteByEmail(
      "ws1",
      { email: "n@b.co", role: "agent", name: "New", password: "secret12" } as never,
      actor,
    );
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.user.create.mock.calls[0][0].data.password).not.toBe("secret12");
    expect(res.tempPassword).toBe("secret12");
    expect(res.created).toBe(true);
  });
});
