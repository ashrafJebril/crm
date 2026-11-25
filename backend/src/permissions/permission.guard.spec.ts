import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { MODULE_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { SearchController } from "../search/search.controller";
import { AuthController } from "../auth/auth.controller";
import { WorkspacesController } from "../workspaces/workspaces.controller";
import { AdminController } from "../admin/admin.controller";
import { AdsController } from "../ads/ads.controller";
import { PermissionGuard } from "./permission.guard";
import { SYSTEM_ROLES, SystemRoleKey } from "./system-roles";
import { ContactsController } from "../contacts/contacts.controller";
import { ConversationsController } from "../conversations/conversations.controller";
import { CustomFieldsController } from "../custom-fields/custom-fields.controller";
import { NotificationsController } from "../notifications/notifications.controller";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-permission-guard-spec";

describe("PermissionGuard", () => {
  let perms: { effective: jest.Mock; can: jest.Mock };
  let guard: PermissionGuard;

  function ctx(cls: Function, handler: Function, user?: Record<string, unknown>) {
    const req: Record<string, unknown> = { user };
    const c = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => cls,
    } as unknown as ExecutionContext;
    return { c, req };
  }

  function asRole(role: SystemRoleKey) {
    perms.effective.mockResolvedValue({
      roleId: `r_${role}`,
      key: role,
      name: SYSTEM_ROLES[role].name,
      nameAr: SYSTEM_ROLES[role].nameAr,
      permissions: SYSTEM_ROLES[role].permissions,
      conversationVisibility: "all",
    });
  }

  beforeEach(() => {
    const { hasPermission } = jest.requireActual("./permission.service");
    perms = {
      effective: jest.fn(),
      can: jest.fn((eff, p) => !!eff && hasPermission(eff.permissions, p)),
    };
    guard = new PermissionGuard(new Reflector(), perms as never);
  });

  const user = { sub: "u1", workspaceId: "ws1" };

  it("guard: viewer cannot POST /contacts → 403 names contacts.create", async () => {
    asRole("viewer");
    const { c } = ctx(ContactsController, ContactsController.prototype.create, user);
    const err = await guard.canActivate(c).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ message: "Missing permission", permission: "contacts.create" });
  });

  it("guard: agent can PATCH /conversations/:id", async () => {
    asRole("agent");
    const { c, req } = ctx(ConversationsController, ConversationsController.prototype.update, user);
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(perms.effective).toHaveBeenCalledWith("ws1", "u1");
    expect((req as any).permissions?.key).toBe("agent"); // resolved once, kept on the request
  });

  it("guard: agent cannot DELETE /contacts/:id", async () => {
    asRole("agent");
    const { c } = ctx(ContactsController, ContactsController.prototype.remove, user);
    await expect(guard.canActivate(c)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("guard: super-admin bypass", async () => {
    const { c } = ctx(ContactsController, ContactsController.prototype.create, { ...user, isSuperAdmin: true });
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("guard: impersonation bypasses ordinary permissions", async () => {
    const imp = { ...user, impersonating: true };
    for (const [cls, h] of [
      [ContactsController, ContactsController.prototype.create],
      [ContactsController, ContactsController.prototype.remove],
      [CustomFieldsController, CustomFieldsController.prototype.create], // settings.manage
    ] as const) {
      await expect(guard.canActivate(ctx(cls, h, imp).c)).resolves.toBe(true);
    }
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("guard: impersonation cannot spend — billing.* and campaigns.manage are 403", async () => {
    const imp = { ...user, impersonating: true };
    for (const [h, perm] of [
      [AdsController.prototype.topup, "billing.update"],
      [AdsController.prototype.approveAction, "campaigns.manage"],
      [AdsController.prototype.rejectAction, "campaigns.manage"],
    ] as const) {
      const err = await guard.canActivate(ctx(AdsController, h, imp).c).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ message: "Not allowed during impersonation", permission: perm });
    }
    // A super-admin session (not impersonation) still bypasses everything.
    await expect(guard.canActivate(ctx(AdsController, AdsController.prototype.topup, { ...user, isSuperAdmin: true }).c)).resolves.toBe(true);
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("guard: no workspace user → skip; workspace handlers then 401 via @CurrentWorkspace()", async () => {
    const a = ctx(ContactsController, ContactsController.prototype.create, undefined);
    await expect(guard.canActivate(a.c)).resolves.toBe(true);
    const b = ctx(ContactsController, ContactsController.prototype.create, { sub: "u1" });
    await expect(guard.canActivate(b.c)).resolves.toBe(true);
    expect(perms.effective).not.toHaveBeenCalled();

    // The skip is safe only because workspace-scoped handlers take
    // @CurrentWorkspace(), which 401s a token without a workspace.
    class Probe { m(@CurrentWorkspace() _ws: string) { return _ws; } }
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "m") as Record<string, { factory: Function }>;
    const factory = Object.values(args)[0].factory;
    expect(() => factory(undefined, b.c)).toThrow(UnauthorizedException);
    const create = Reflect.getMetadata(ROUTE_ARGS_METADATA, ContactsController, "create") as Record<string, unknown>;
    expect(Object.keys(create).some((k) => k.includes("__customRouteArgs__"))).toBe(true);
  });

  it("guard: non-member gets 403 Not a member", async () => {
    perms.effective.mockResolvedValue(null);
    const { c } = ctx(ContactsController, ContactsController.prototype.list, user);
    const err = await guard.canActivate(c).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ message: "Not a member" });
  });

  it("guard: authenticated routes need membership but no permission", async () => {
    asRole("viewer");
    const { c } = ctx(NotificationsController, NotificationsController.prototype.list, user);
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(perms.effective).toHaveBeenCalledWith("ws1", "u1");
  });

  it("guard: removed member gets 403 on GET /search and notifications", async () => {
    perms.effective.mockResolvedValue(null);
    for (const [cls, h] of [
      [SearchController, SearchController.prototype.search],
      [NotificationsController, NotificationsController.prototype.list],
      [NotificationsController, NotificationsController.prototype.unreadCount],
    ] as const) {
      const err = await guard.canActivate(ctx(cls, h, user).c).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ message: "Not a member" });
    }
  });

  it("guard: /auth/*, /admin/* and workspace list/create work without membership", async () => {
    perms.effective.mockResolvedValue(null);
    for (const [cls, h] of [
      [AuthController, AuthController.prototype.me],
      [AuthController, AuthController.prototype.myWorkspaces],
      [AuthController, AuthController.prototype.switchWorkspace],
      [AuthController, AuthController.prototype.changePassword],
      [AdminController, AdminController.prototype.listWorkspaces],
      [WorkspacesController, WorkspacesController.prototype.list],
      [WorkspacesController, WorkspacesController.prototype.create],
    ] as const) {
      await expect(guard.canActivate(ctx(cls, h, user).c)).resolves.toBe(true);
    }
    expect(perms.effective).not.toHaveBeenCalled();
  });

  it("guard: @RequirePermission metadata decides (custom-field definitions are settings.manage)", async () => {
    asRole("agent");
    const { c } = ctx(CustomFieldsController, CustomFieldsController.prototype.create, user);
    const err = await guard.canActivate(c).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ permission: "settings.manage" });
    asRole("admin");
    await expect(guard.canActivate(ctx(CustomFieldsController, CustomFieldsController.prototype.create, user).c)).resolves.toBe(true);
  });

  it("guard: an unmapped route fails closed for members", async () => {
    class Stray { handle() { return 1; } }
    asRole("owner");
    const { c } = ctx(Stray, Stray.prototype.handle, user);
    await expect(guard.canActivate(c)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("contacts bulk delete needs contacts.delete, not just the route's contacts.update", async () => {
    const bulkSvc = { run: jest.fn().mockResolvedValue({ ok: true }) };
    const ctrl = new ContactsController({} as never, bulkSvc as never, {} as never, {} as never, {} as never);
    const reqAs = (role: SystemRoleKey) => ({
      user,
      permissions: { roleId: "r", key: role, name: role, nameAr: role, permissions: SYSTEM_ROLES[role].permissions, conversationVisibility: "all" },
    });
    const del = { op: "delete", ids: ["c1"] } as never;
    let err: any;
    try { ctrl.bulk("ws1", del, reqAs("agent") as never); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ permission: "contacts.delete" });
    expect(bulkSvc.run).not.toHaveBeenCalled();

    await ctrl.bulk("ws1", { op: "tag", ids: ["c1"] } as never, reqAs("agent") as never);
    await ctrl.bulk("ws1", del, reqAs("admin") as never);
    await ctrl.bulk("ws1", del, { user: { ...user, isSuperAdmin: true } } as never);
    expect(bulkSvc.run).toHaveBeenCalledTimes(3);
  });

  it("is registered as a global guard right after AuthGuard", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AuthModule } = require("../auth/auth.module");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AuthGuard } = require("../auth/auth.guard");
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) as Array<{ provide?: unknown; useClass?: unknown }>;
    const guards = providers.filter((p) => p && p.provide === APP_GUARD).map((p) => p.useClass);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PlanFeatureGuard } = require("../billing/plan-feature.guard");
    // SP-28: the plan gate runs third, after the permission check.
    expect(guards).toEqual([AuthGuard, PermissionGuard, PlanFeatureGuard]);
  });
});
