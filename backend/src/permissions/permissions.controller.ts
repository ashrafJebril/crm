import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import { flattenPermissions, type Permission } from "./catalog";
import { PermissionService } from "./permission.service";
import type { PermissionRequest } from "./permission.guard";
import { SYSTEM_ROLES, type ConversationVisibility } from "./system-roles";

export interface MyPermissions {
  roleId: string | null;
  key: string | null;
  name: string;
  permissions: Permission[];
  conversationVisibility: ConversationVisibility;
}

@Controller("me")
export class PermissionsController {
  constructor(private readonly perms: PermissionService) {}

  /** The caller's effective role in the current workspace, for UI gating. */
  @Get("permissions")
  async mine(@Req() req: PermissionRequest): Promise<MyPermissions> {
    const u = req.user;
    // Super-admin / impersonation sessions bypass every check server-side,
    // so the UI should not hide anything from them either.
    if (u?.isSuperAdmin === true || u?.impersonating === true) {
      return {
        roleId: null,
        key: "owner",
        name: SYSTEM_ROLES.owner.name,
        permissions: flattenPermissions(SYSTEM_ROLES.owner.permissions),
        conversationVisibility: "all",
      };
    }
    if (!u?.workspaceId) throw new ForbiddenException({ statusCode: 403, message: "Not a member" });
    const eff = req.permissions ?? (await this.perms.effective(u.workspaceId, u.sub));
    if (!eff) throw new ForbiddenException({ statusCode: 403, message: "Not a member" });
    return {
      roleId: eff.roleId,
      key: eff.key,
      name: eff.name,
      permissions: flattenPermissions(eff.permissions),
      conversationVisibility: eff.conversationVisibility,
    };
  }
}
