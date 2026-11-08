import { BadRequestException, NotFoundException } from "@nestjs/common";
import { WorkspacesService } from "./workspaces.service";

const sys = (key: string) => ({ id: `r_${key}`, workspaceId: "ws1", key, isSystem: true, name: key, nameAr: key });
const custom = { id: "r_custom", workspaceId: "ws1", key: null, isSystem: false, name: "Billing", nameAr: "x" };

describe("WorkspacesService member roles (SP-25)", () => {
  let prisma: any;
  let permissions: { systemRoleId: jest.Mock; invalidate: jest.Mock };
  let svc: WorkspacesService;

  beforeEach(() => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn().mockResolvedValue({ id: "m1", role: "owner", roleId: "r_owner", roleRef: sys("owner") }),
        // other members of the workspace (excluding the target): one more owner by default
        findMany: jest.fn().mockResolvedValue([{ id: "m2", role: "owner", roleId: null, roleRef: null }]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "m1", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      role: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    permissions = { systemRoleId: jest.fn().mockResolvedValue("r_agent"), invalidate: jest.fn() };
    svc = new WorkspacesService(prisma, {} as never, permissions as never);
  });

  describe("updateMemberRole with a legacy role string", () => {
    it("sets roleId to the matching system role and invalidates the member cache", async () => {
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

    it("rejects a body with neither role nor roleId", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", {} as never)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("updateMemberRole with roleId", () => {
    it("custom role assignment syncs legacy role string to agent", async () => {
      prisma.role.findFirst.mockResolvedValue(custom);
      await svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" });
      expect(prisma.role.findFirst).toHaveBeenCalledWith({ where: { id: "r_custom", workspaceId: "ws1" } });
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { role: "agent", roleId: "r_custom" },
      });
      expect(permissions.invalidate).toHaveBeenCalledWith("ws1", "u1");
    });

    it("system role by id syncs legacy string to its key", async () => {
      prisma.role.findFirst.mockResolvedValue(sys("admin"));
      await svc.updateMemberRole("ws1", "u1", { roleId: "r_admin" });
      expect(prisma.workspaceMember.update.mock.calls[0][0].data).toEqual({ role: "admin", roleId: "r_admin" });
    });

    it("foreign role id -> 404", async () => {
      prisma.role.findFirst.mockResolvedValue(null);
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "other" })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
    });

    it("a role row from another workspace (tenancy rewrite) -> 404", async () => {
      prisma.role.findFirst.mockResolvedValue({ ...custom, workspaceId: "wsX" });
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("last-owner rule", () => {
    beforeEach(() => prisma.workspaceMember.findMany.mockResolvedValue([])); // m1 is the only owner

    it("demoting last owner -> 400", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
    });

    it("moving the last owner to a custom role -> 400", async () => {
      prisma.role.findFirst.mockResolvedValue(custom);
      await expect(svc.updateMemberRole("ws1", "u1", { roleId: "r_custom" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a member whose custom role overrides the legacy owner string is not an owner", async () => {
      prisma.workspaceMember.findMany.mockResolvedValue([
        { id: "m2", role: "owner", roleId: "r_custom", roleRef: custom },
      ]);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "agent" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("re-saving the owner role of the last owner is fine", async () => {
      await expect(svc.updateMemberRole("ws1", "u1", { role: "owner" })).resolves.toBeDefined();
    });

    it("demoting an owner is fine when another owner exists", async () => {
      prisma.workspaceMember.findMany.mockResolvedValue([{ id: "m2", role: "owner", roleId: null, roleRef: null }]);
      await expect(svc.updateMemberRole("ws1", "u1", { role: "admin" })).resolves.toBeDefined();
    });

    it("removing the last owner -> 400", async () => {
      await expect(svc.removeMember("ws1", "u1")).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it("removing a non-owner is fine and invalidates the cache", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue({ id: "m3", role: "agent", roleId: null, roleRef: null });
      await expect(svc.removeMember("ws1", "u3")).resolves.toEqual({ ok: true });
      expect(permissions.invalidate).toHaveBeenCalledWith("ws1", "u3");
    });
  });

  describe("adding members by legacy role string maps to the system role", () => {
    it("addMember stores roleId", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      prisma.workspaceMember.create = jest.fn().mockResolvedValue({ id: "n" });
      await svc.addMember("ws1", { userId: "u5", role: "agent" });
      expect(prisma.workspaceMember.create).toHaveBeenCalledWith({
        data: { userId: "u5", workspaceId: "ws1", role: "agent", roleId: "r_agent" },
      });
    });
  });
});
