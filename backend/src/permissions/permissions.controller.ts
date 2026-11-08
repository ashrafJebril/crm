import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import { flattenPermissions, type Permission } from "./catalog";
import { PermissionService } from "./permission.service";
import { blockedForImpersonation, type PermissionRequest } from "./permission.guard";
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
    // Super-admin sessions bypass every check server-side; impersonation
    // bypasses all but spend permissions. Mirror that so the UI matches.
    if (u?.isSuperAdmin === true || u?.impersonating === true) {
      const all = flattenPermissions(SYSTEM_ROLES.owner.permissions);
      return {
        roleId: null,
        key: "owner",
        name: SYSTEM_ROLES.owner.name,
        permissions: u.isSuperAdmin === true ? all : all.filter((p) => !blockedForImpersonation(p)),
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
