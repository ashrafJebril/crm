import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { PermissionService, type EffectiveRole } from "./permission.service";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator";
import { ROUTE_PERMISSIONS, membershipExempt, routeKeysFor, type RouteRule } from "./permission-map";
import type { Permission } from "./catalog";

export type PermissionRequest = Request & { user?: JwtPayload; permissions?: EffectiveRole };

export function missingPermission(permission: string): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, message: "Missing permission", permission });
}

/** Impersonation (a support session: `impersonating`, NOT `isSuperAdmin` —
 *  AdminService.impersonateWorkspace deliberately omits it) bypasses every
 *  check except spending the tenant's money: billing.* and campaigns.manage
 *  (ads spend approval/rejection, campaign launch). Topping up the ads
 *  wallet is billing.update. */
export function blockedForImpersonation(permission: string): boolean {
  return permission.startsWith("billing.") || permission === "campaigns.manage";
}

function impersonationDenied(permission: string): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    message: "Not allowed during impersonation",
    permission,
  });
}

/** For checks that depend on the request body (e.g. a bulk op of "delete").
 *  Uses the role PermissionGuard already resolved for this request. */
export function assertRequestPermission(req: PermissionRequest, permission: Permission): void {
  const u = req.user;
  if (!u?.workspaceId || u.isSuperAdmin === true) return;
  if (u.impersonating === true) {
    if (blockedForImpersonation(permission)) throw impersonationDenied(permission);
    return;
  }
  const acts = (req.permissions?.permissions as Record<string, string[] | undefined> | undefined)?.[
    permission.split(".")[0]
  ];
  if (!acts?.includes(permission.split(".")[1])) throw missingPermission(permission);
}

/**
 * Global (APP_GUARD) permission check. Registered in AuthModule right after
 * AuthGuard so req.user is populated — global guards run in registration
 * order, and AppModule's own APP_GUARDs would run before AuthModule's.
 *
 *  - no req.user.workspaceId: skip. That is public routes, webhooks, and
 *    tokens issued before a workspace was picked; every workspace-scoped
 *    handler reads the workspace through @CurrentWorkspace(), which 401s
 *    such a token, so skipping here never opens tenant data.
 *  - rule: @RequirePermission metadata, else ROUTE_PERMISSIONS["METHOD /path"]
 *  - "public": pass
 *  - "authenticated" on an own-account route (/auth/*, /admin/*, workspace
 *    list/create): pass without membership
 *  - super-admin: pass
 *  - impersonation: pass, except billing.* and campaigns.manage → 403
 *  - non-member: 403 { message: "Not a member" } (also for "authenticated")
 *  - "authenticated": pass
 *  - unmapped route: 403 (fail closed; permission-map.spec prevents this)
 *  - missing permission: 403 { message: "Missing permission", permission }
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly perms: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const req = ctx.switchToHttp().getRequest<PermissionRequest>();
    const user = req.user;
    if (!user?.workspaceId) return true;

    const { rule, key } = this.resolve(ctx);
    if (rule === "public") return true;
    if (rule === "authenticated" && key !== undefined && membershipExempt(key)) return true;
    if (user.isSuperAdmin === true) return true;
    if (user.impersonating === true) {
      if (rule !== undefined && rule !== "authenticated" && blockedForImpersonation(rule)) {
        throw impersonationDenied(rule);
      }
      return true;
    }

    const eff = await this.perms.effective(user.workspaceId, user.sub);
    if (!eff) throw new ForbiddenException({ statusCode: 403, message: "Not a member" });
    req.permissions = eff;

    if (rule === "authenticated") return true;
    if (rule === undefined) {
      throw new ForbiddenException({ statusCode: 403, message: "Route has no permission mapping" });
    }
    if (!this.perms.can(eff, rule)) throw missingPermission(rule);
    return true;
  }

  private resolve(ctx: ExecutionContext): { rule: RouteRule | undefined; key: string | undefined } {
    const keys = routeKeysFor(ctx.getClass(), ctx.getHandler());
    const explicit = this.reflector.get<Permission | undefined>(REQUIRE_PERMISSION_KEY, ctx.getHandler());
    if (explicit) return { rule: explicit, key: keys[0] };
    for (const key of keys) {
      const rule = ROUTE_PERMISSIONS[key];
      if (rule !== undefined) return { rule, key };
    }
    return { rule: undefined, key: keys[0] };
  }
}
