import { TeamController } from "./team.module";

const user = { id: "u1", email: "a@b", name: "A", initials: "A", color: "1", status: "online" };
const sys = (key: string, name: string) => ({ id: `r_${key}`, key, isSystem: true, name, nameAr: `ar_${name}` });
const custom = { id: "r_c", key: null, isSystem: false, name: "Billing", nameAr: "فواتير" };

describe("GET /team role fields", () => {
  const make = (members: unknown[], roles: unknown[]) => {
    const prisma: any = {
      workspaceMember: { findMany: jest.fn().mockResolvedValue(members) },
      role: { findMany: jest.fn().mockResolvedValue(roles) },
    };
    const permissions: any = { ensureSystemRoles: jest.fn() };
    return new TeamController(prisma, permissions);
  };

  it("returns roleId/roleName/roleNameAr of the effective role", async () => {
    const roles = [sys("agent", "Agent"), sys("owner", "Owner")];
    const ctl = make(
      [
        { user, role: "agent", roleId: null, roleRef: null },
        { user: { ...user, id: "u2" }, role: "agent", roleId: "r_c", roleRef: custom },
        { user: { ...user, id: "u3" }, role: "agent", roleId: "r_owner", roleRef: roles[1] }, // stale system id
      ],
      roles,
    );
    const out = await ctl.list("ws1");
    expect(out[0]).toMatchObject({ role: "agent", roleId: "r_agent", roleName: "Agent", roleNameAr: "ar_Agent" });
    expect(out[1]).toMatchObject({ role: "agent", roleId: "r_c", roleName: "Billing", roleNameAr: "فواتير" });
    expect(out[2]).toMatchObject({ roleId: "r_agent", roleName: "Agent" });
  });
});
