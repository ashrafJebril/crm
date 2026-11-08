import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RolesService } from "./roles.service";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { SYSTEM_ROLES } from "../permissions/system-roles";

const actor: Actor = { userId: "actor" };

const row = (over: Record<string, unknown>) => ({
  id: "r1", workspaceId: "ws1", key: null, name: "Billing", nameAr: "x", isSystem: false,
  permissions: { contacts: ["view"] }, conversationVisibility: "all",
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe("RolesService", () => {
  let prisma: any;
  let permissions: { ensureSystemRoles: jest.Mock; invalidate: jest.Mock; assertCanGrant: jest.Mock };
  let svc: RolesService;

  beforeEach(() => {
    prisma = {
      role: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
        delete: jest.fn().mockResolvedValue({}),
      },
      workspaceMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    permissions = { ensureSystemRoles: jest.fn(), invalidate: jest.fn(), assertCanGrant: jest.fn() };
    svc = new RolesService(prisma, permissions as never);
  });

  it("list returns roles with effective memberCount", async () => {
    const owner = row({ id: "ro", key: "owner", isSystem: true, name: "Owner" });
    const agent = row({ id: "ra", key: "agent", isSystem: true, name: "Agent" });
    const cust = row({ id: "rc", name: "Billing" });
    prisma.role.findMany.mockResolvedValue([cust, agent, owner]);
    prisma.workspaceMember.findMany.mockResolvedValue([
      { role: "owner", roleId: null, roleRef: null },
      { role: "agent", roleId: "rc", roleRef: cust },
      { role: "agent", roleId: null, roleRef: null },
      { role: "viewer", roleId: "ra", roleRef: agent }, // stale system roleId loses to the legacy string
    ]);
    const out = await svc.list("ws1");
    expect(permissions.ensureSystemRoles).toHaveBeenCalledWith("ws1");
    expect(out.map((r) => [r.key, r.memberCount])).toEqual([["owner", 1], ["agent", 1], [null, 1]]);
  });

  it("create validates permissions and stores a custom role", async () => {
    const res = await svc.create("ws1", {
      name: " QA ", nameAr: "ج", permissions: { contacts: ["view", "view"] }, conversationVisibility: "assigned",
    }, actor);
    expect(prisma.role.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws1", key: null, name: "QA", isSystem: false,
      permissions: { contacts: ["view"] }, conversationVisibility: "assigned",
    });
    expect(res.memberCount).toBe(0);
  });

  it("invalid permission -> 400", async () => {
    await expect(svc.create("ws1", { name: "a", nameAr: "b", permissions: { nope: ["view"] } }, actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("ws1", { name: "a", nameAr: "b", permissions: { contacts: ["fly"] } }, actor)).rejects.toBeInstanceOf(BadRequestException);
    prisma.role.findFirst.mockResolvedValue(row({}));
    await expect(svc.update("ws1", "r1", { permissions: { nope: [] } }, actor)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.role.create).not.toHaveBeenCalled();
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it("duplicate name -> 409", async () => {
    prisma.role.findFirst.mockResolvedValue(row({ id: "other" }));
    await expect(svc.create("ws1", { name: "Billing", nameAr: "b", permissions: {} }, actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it("owner role immutable", async () => {
    prisma.role.findFirst.mockResolvedValue(row({ key: "owner", isSystem: true }));
    await expect(svc.update("ws1", "r1", { name: "Boss" }, actor)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it("system role key is never written; other fields editable; cache invalidated", async () => {
    prisma.role.findFirst.mockResolvedValue(row({ key: "agent", isSystem: true, name: "Agent" }));
    const body = { nameAr: "موظف", permissions: { contacts: ["view"] }, key: "owner" } as never;
    await svc.update("ws1", "r1", body, actor);
    const data = prisma.role.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("key");
    expect(data.nameAr).toBe("موظف");
    expect(permissions.invalidate).toHaveBeenCalledWith("ws1");
  });

  it("update of a foreign role id -> 404", async () => {
    await expect(svc.update("ws1", "zzz", { name: "a" }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot delete system role", async () => {
    prisma.role.findFirst.mockResolvedValue(row({ key: "agent", isSystem: true }));
    await expect(svc.remove("ws1", "r1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it("cannot delete a role in use", async () => {
    prisma.role.findFirst.mockResolvedValue(row({}));
    prisma.workspaceMember.count.mockResolvedValue(3);
    const err: any = await svc.remove("ws1", "r1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ members: 3 });
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it("deletes an unused custom role", async () => {
    prisma.role.findFirst.mockResolvedValue(row({}));
    await expect(svc.remove("ws1", "r1")).resolves.toEqual({ ok: true });
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });

  it("in-use check and delete share one transaction", async () => {
    prisma.role.findFirst.mockResolvedValue(row({}));
    await svc.remove("ws1", "r1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("delete of a foreign role id -> 404", async () => {
    await expect(svc.remove("ws1", "zzz")).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("cannot grant more than you hold", () => {
    let real: RolesService;
    let effective: jest.Mock;
    const eff = (perms: Record<string, string[]>) => ({
      roleId: "r", key: null, name: "c", nameAr: "c", permissions: perms, conversationVisibility: "all",
    });
    beforeEach(() => {
      const ps = new PermissionService(prisma);
      effective = jest.fn().mockResolvedValue(eff(SYSTEM_ROLES.admin.permissions as never));
      (ps as any).effective = effective;
      (ps as any).invalidate = jest.fn();
      real = new RolesService(prisma, ps);
    });

    it("POST /roles with a permission the caller lacks -> 403", async () => {
      const err: any = await real
        .create("ws1", { name: "x", nameAr: "y", permissions: { billing: ["manage"] } }, actor)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe("Cannot grant permissions you don't have");
      expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it("POST /roles within the caller's own permissions is allowed", async () => {
      await expect(
        real.create("ws1", { name: "x", nameAr: "y", permissions: { contacts: ["view", "update"] } }, actor),
      ).resolves.toBeDefined();
    });

    it("PATCH /roles/:id adding a permission the caller lacks -> 403; name-only edit needs no grant", async () => {
      prisma.role.findFirst.mockResolvedValueOnce(row({}));
      await expect(
        real.update("ws1", "r1", { permissions: { roles: ["manage"] } }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.role.update).not.toHaveBeenCalled();
      effective.mockResolvedValue(eff({}));
      prisma.role.findFirst.mockResolvedValueOnce(row({})).mockResolvedValueOnce(null);
      await expect(real.update("ws1", "r1", { nameAr: "z" }, actor)).resolves.toBeDefined();
    });

    it("super-admin bypasses; impersonation cannot grant billing.* or campaigns.manage", async () => {
      effective.mockResolvedValue(eff({}));
      await expect(
        real.create("ws1", { name: "x", nameAr: "y", permissions: { billing: ["manage"] } }, { userId: "s", isSuperAdmin: true }),
      ).resolves.toBeDefined();
      const imp = { userId: "i", impersonating: true };
      await expect(
        real.create("ws1", { name: "x2", nameAr: "y", permissions: { campaigns: ["manage"] } }, imp),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        real.create("ws1", { name: "x3", nameAr: "y", permissions: { contacts: ["delete"] } }, imp),
      ).resolves.toBeDefined();
    });
  });
});
