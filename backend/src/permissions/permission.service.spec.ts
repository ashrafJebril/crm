import { PermissionService } from "./permission.service";
import { SYSTEM_ROLES } from "./system-roles";

describe("PermissionService", () => {
  let prisma: any;
  let svc: PermissionService;

  const agentRole = {
    id: "r_agent",
    workspaceId: "ws1",
    key: "agent",
    name: "Agent",
    nameAr: SYSTEM_ROLES.agent.nameAr,
    isSystem: true,
    permissions: SYSTEM_ROLES.agent.permissions,
    conversationVisibility: "all",
  };

  beforeEach(() => {
    prisma = {
      workspaceMember: { findUnique: jest.fn() },
      role: {
        findFirst: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
    };
    svc = new PermissionService(prisma);
  });

  it("effective falls back from legacy role string when roleId null", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "Agent", roleId: null, roleRef: null });
    prisma.role.findFirst.mockResolvedValue(agentRole);
    const eff = await svc.effective("ws1", "u1");
    expect(prisma.role.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws1", key: "agent" } });
    expect(eff).toMatchObject({ roleId: "r_agent", key: "agent", name: "Agent", conversationVisibility: "all" });
    expect(eff!.permissions).toEqual(SYSTEM_ROLES.agent.permissions);
  });

  it("uses the assigned role when roleId is set", async () => {
    const custom = { ...agentRole, id: "r_c", key: null, name: "Support", isSystem: false, conversationVisibility: "assigned", permissions: { contacts: ["view"] } };
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "agent", roleId: "r_c", roleRef: custom });
    const eff = await svc.effective("ws1", "u1");
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(eff).toMatchObject({ roleId: "r_c", key: null, conversationVisibility: "assigned", permissions: { contacts: ["view"] } });
  });

  it("demotion via legacy role string wins over stale system roleId", async () => {
    const ownerRole = { ...agentRole, id: "r_owner", key: "owner", name: "Owner", permissions: SYSTEM_ROLES.owner.permissions };
    // roleId still points at the owner system role, but deployed code demoted
    // the member by writing only the legacy string.
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "agent", roleId: "r_owner", roleRef: ownerRole });
    prisma.role.findFirst.mockResolvedValue(agentRole);
    const eff = await svc.effective("ws1", "u1");
    expect(prisma.role.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws1", key: "agent" } });
    expect(eff).toMatchObject({ roleId: "r_agent", key: "agent" });
    expect(svc.can(eff, "roles.manage")).toBe(false);
  });

  it("a matching system roleId is used as-is", async () => {
    const ownerRole = { ...agentRole, id: "r_owner", key: "owner", name: "Owner", permissions: SYSTEM_ROLES.owner.permissions };
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "Owner", roleId: "r_owner", roleRef: ownerRole });
    const eff = await svc.effective("ws1", "u1");
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(eff).toMatchObject({ roleId: "r_owner", key: "owner" });
  });

  it("systemRoleId never returns another workspace's role (tenancy rewrite)", async () => {
    prisma.role.findFirst.mockResolvedValue({ ...agentRole, workspaceId: "ws_other" });
    expect(await svc.systemRoleId("ws1", "Agent")).toBeNull();
    prisma.role.findFirst.mockResolvedValue(agentRole);
    expect(await svc.systemRoleId("ws1", "Agent")).toBe("r_agent");
    expect(await svc.systemRoleId("ws1", "analyst")).toBeNull();
  });

  it("creates the system roles lazily when the workspace has none", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "agent", roleId: null, roleRef: null });
    prisma.role.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(agentRole);
    const eff = await svc.effective("ws1", "u1");
    expect(prisma.role.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.role.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data.map((d: any) => d.key).sort()).toEqual(["admin", "agent", "owner", "viewer"]);
    expect(arg.data.every((d: any) => d.workspaceId === "ws1" && d.isSystem === true)).toBe(true);
    expect(eff?.key).toBe("agent");
  });

  it("returns null for a non-member and does not cache it", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await svc.effective("ws1", "u1")).toBeNull();
    expect(await svc.effective("ws1", "u1")).toBeNull();
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(2);
  });

  it("drops unknown keys stored in a role's permissions", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({
      role: "agent",
      roleId: "r_x",
      roleRef: { ...agentRole, id: "r_x", permissions: { contacts: ["view", "fly"], nope: ["view"] } },
    });
    const eff = await svc.effective("ws1", "u1");
    expect(eff!.permissions).toEqual({ contacts: ["view"] });
  });

  it("cache hit avoids second query; invalidate clears", async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: "agent", roleId: null, roleRef: null });
    prisma.role.findFirst.mockResolvedValue(agentRole);
    await svc.effective("ws1", "u1");
    await svc.effective("ws1", "u1");
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(1);

    svc.invalidate("ws1", "u1");
    await svc.effective("ws1", "u1");
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(2);

    await svc.effective("ws1", "u2");
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(3);
    svc.invalidate("ws1"); // whole workspace
    await svc.effective("ws1", "u1");
    await svc.effective("ws1", "u2");
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(5);
  });

  it("cache entries expire after 30 s", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      prisma.workspaceMember.findUnique.mockResolvedValue({ role: "agent", roleId: null, roleRef: null });
      prisma.role.findFirst.mockResolvedValue(agentRole);
      await svc.effective("ws1", "u1");
      now += 29_000;
      await svc.effective("ws1", "u1");
      expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(1);
      now += 2_000;
      await svc.effective("ws1", "u1");
      expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.restoreAllMocks();
    }
  });

  describe("membersWith (SP-14)", () => {
    const sys = (key: "owner" | "admin" | "agent" | "viewer") => ({
      ...agentRole,
      id: `r_${key}`,
      key,
      name: key,
      permissions: SYSTEM_ROLES[key].permissions,
    });

    it("lists members whose effective role grants the permission, in one member query", async () => {
      const custom = { ...agentRole, id: "r_c", key: null, name: "Channel lead", isSystem: false, permissions: { channels: ["view", "update"] } };
      const ownerRole = sys("owner");
      prisma.workspaceMember.findMany = jest.fn().mockResolvedValue([
        { userId: "u_owner", role: "owner", roleId: "r_owner", roleRef: ownerRole },
        { userId: "u_admin", role: "admin", roleId: null, roleRef: null },
        { userId: "u_agent", role: "agent", roleId: null, roleRef: null },
        { userId: "u_viewer", role: "viewer", roleId: null, roleRef: null },
        { userId: "u_custom", role: "agent", roleId: "r_c", roleRef: custom },
        // A stale system roleId (demoted by the legacy string) follows the string, as in `effective`.
        { userId: "u_demoted", role: "agent", roleId: "r_owner", roleRef: ownerRole },
        { userId: "u_odd", role: "intern", roleId: null, roleRef: null },
      ]);
      prisma.role.findFirst.mockImplementation(async ({ where }: any) => (["owner", "admin", "agent", "viewer"].includes(where.key) ? sys(where.key) : null));

      const ids = await svc.membersWith("ws1", "channels.update");
      expect(ids.sort()).toEqual(["u_admin", "u_custom", "u_owner"]);
      expect(prisma.workspaceMember.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws1" }, include: { roleRef: true } });
      // One system-role lookup per distinct legacy key, not per member.
      const keys = prisma.role.findFirst.mock.calls.map((c: any) => c[0].where.key).sort();
      expect(keys).toEqual(["admin", "agent", "viewer"]);
    });

    it("an empty workspace has nobody", async () => {
      prisma.workspaceMember.findMany = jest.fn().mockResolvedValue([]);
      expect(await svc.membersWith("ws1", "channels.update")).toEqual([]);
    });
  });

  it("can checks resource.action", () => {
    const eff = { roleId: "r", key: "agent", name: "Agent", nameAr: "", permissions: SYSTEM_ROLES.agent.permissions, conversationVisibility: "all" as const };
    expect(svc.can(eff, "contacts.create")).toBe(true);
    expect(svc.can(eff, "contacts.delete")).toBe(false);
    expect(svc.can(null, "contacts.view")).toBe(false);
  });
});
