import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { PermissionService, type EffectiveRole } from "./permission.service";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator";
import { ROUTE_PERMISSIONS, routeKeysFor, type RouteRule } from "./permission-map";
import type { Permission } from "./catalog";

export type PermissionRequest = Request & { user?: JwtPayload; permissions?: EffectiveRole };

export function missingPermission(permission: string): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, message: "Missing permission", permission });
}

/** For checks that depend on the request body (e.g. a bulk op of "delete").
 *  Uses the role PermissionGuard already resolved for this request. */
export function assertRequestPermission(req: PermissionRequest, permission: Permission): void {
  const u = req.user;
  if (!u?.workspaceId || u.isSuperAdmin === true || u.impersonating === true) return;
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
 *  - no req.user.workspaceId (public routes, webhooks, pre-workspace tokens): skip
 *  - @RequirePermission metadata, else ROUTE_PERMISSIONS["METHOD /path"]
 *  - "public" / "authenticated": pass
 *  - super-admin / impersonation: pass (as WorkspaceRolesGuard did)
 *  - non-member: 403 { message: "Not a member" }
 *  - missing permission: 403 { message: "Missing permission", permission }
 *  - unmapped route: 403 (fail closed; permission-map.spec prevents this)
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

    const rule = this.resolve(ctx);
    if (rule === "public" || rule === "authenticated") return true;
    if (user.isSuperAdmin === true || user.impersonating === true) return true;

    const eff = await this.perms.effective(user.workspaceId, user.sub);
    if (!eff) throw new ForbiddenException({ statusCode: 403, message: "Not a member" });
    req.permissions = eff;

    if (rule === undefined) {
      throw new ForbiddenException({ statusCode: 403, message: "Route has no permission mapping" });
    }
    if (!this.perms.can(eff, rule)) throw missingPermission(rule);
    return true;
  }

  private resolve(ctx: ExecutionContext): RouteRule | undefined {
    const explicit = this.reflector.get<Permission | undefined>(REQUIRE_PERMISSION_KEY, ctx.getHandler());
    if (explicit) return explicit;
    for (const key of routeKeysFor(ctx.getClass(), ctx.getHandler())) {
      const rule = ROUTE_PERMISSIONS[key];
      if (rule !== undefined) return rule;
    }
    return undefined;
  }
}
