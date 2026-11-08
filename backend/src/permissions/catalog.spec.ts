import { BadRequestException } from "@nestjs/common";
import { validatePermissions } from "./catalog";
import { visibleConversationWhere } from "./visibility";
import { PermissionsController } from "./permissions.controller";
import { SYSTEM_ROLES } from "./system-roles";

describe("validatePermissions", () => {
  it("normalizes: dedupes and orders actions, keeps empty resources", () => {
    expect(validatePermissions({ contacts: ["update", "view", "view"], tickets: [] })).toEqual({
      contacts: ["view", "update"],
      tickets: [],
    });
  });

  it.each([
    [{ nope: ["view"] }],
    [{ contacts: ["fly"] }],
    [{ contacts: "view" }],
    [["contacts.view"]],
    [null],
    ["x"],
  ])("rejects %j with 400", (input) => {
    expect(() => validatePermissions(input)).toThrow(BadRequestException);
  });
});

describe("visibleConversationWhere", () => {
  it("returns {} for all", () => {
    expect(visibleConversationWhere({ conversationVisibility: "all" }, "u1")).toEqual({});
  });
  it("returns assignee filter for assigned", () => {
    expect(visibleConversationWhere({ conversationVisibility: "assigned" }, "u1")).toEqual({ assigneeId: "u1" });
  });
  it("returns {} without an effective role (super-admin / impersonation)", () => {
    expect(visibleConversationWhere(null, "u1")).toEqual({});
  });
});

describe("GET /me/permissions", () => {
  const perms = { effective: jest.fn() };
  const ctrl = new PermissionsController(perms as never);

  it("returns the effective role with a flat permission list", async () => {
    perms.effective.mockResolvedValue({
      roleId: "r1",
      key: "agent",
      name: "Agent",
      nameAr: SYSTEM_ROLES.agent.nameAr,
      permissions: { contacts: ["view", "create"], tickets: ["view"] },
      conversationVisibility: "assigned",
    });
    const res = await ctrl.mine({ user: { sub: "u1", workspaceId: "ws1" } } as never);
    expect(res).toEqual({
      roleId: "r1",
      key: "agent",
      name: "Agent",
      permissions: ["contacts.view", "contacts.create", "tickets.view"],
      conversationVisibility: "assigned",
    });
  });

  it("gives super-admins every permission", async () => {
    perms.effective.mockClear();
    const res = await ctrl.mine({ user: { sub: "u1", workspaceId: "ws1", isSuperAdmin: true } } as never);
    expect(res.key).toBe("owner");
    expect(res.permissions).toContain("roles.manage");
    expect(res.permissions).toContain("billing.manage");
    expect(res.permissions).toContain("campaigns.manage");
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("gives impersonation everything except billing.* and campaigns.manage", async () => {
    perms.effective.mockClear();
    const res = await ctrl.mine({ user: { sub: "u1", workspaceId: "ws1", impersonating: true } } as never);
    expect(res.permissions).toContain("roles.manage");
    expect(res.permissions).toContain("campaigns.update");
    expect(res.permissions.filter((p) => p.startsWith("billing.") || p === "campaigns.manage")).toEqual([]);
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("403 for a non-member", async () => {
    perms.effective.mockResolvedValue(null);
    await expect(ctrl.mine({ user: { sub: "u1", workspaceId: "ws1" } } as never)).rejects.toMatchObject({ status: 403 });
  });
});
