import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { sanitizePermissions, type Permission, type PermissionsJson } from "./catalog";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, type ConversationVisibility } from "./system-roles";

export interface EffectiveRole {
  roleId: string | null;
  key: string | null;
  name: string;
  nameAr: string;
  permissions: PermissionsJson;
  conversationVisibility: ConversationVisibility;
}

/** Pure check: does the matrix grant `resource.action`? */
export function hasPermission(perms: PermissionsJson, permission: Permission | string): boolean {
  const [res, act] = permission.split(".");
  const acts = (perms as Record<string, readonly string[] | undefined>)[res];
  return Array.isArray(acts) && acts.includes(act);
}

const TTL_MS = 30_000;

type RoleRow = {
  id: string;
  workspaceId?: string;
  isSystem?: boolean;
  key: string | null;
  name: string;
  nameAr: string;
  permissions: Prisma.JsonValue;
  conversationVisibility: string;
};

@Injectable()
export class PermissionService {
  private readonly cache = new Map<string, { value: EffectiveRole; expires: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The member's effective role in a workspace, or null for a non-member.
   * `roleId` wins; otherwise the workspace's system role whose key equals the
   * legacy `WorkspaceMember.role` string. System roles missing for a
   * workspace created after the migration are created here, lazily.
   * Cached in memory for 30 s per (workspaceId, userId); non-members are not
   * cached so a freshly added member is let in immediately.
   *
   * Runs from the global guard, before WorkspaceInterceptor sets a tenancy
   * context, so every query carries an explicit workspaceId.
   */
  async effective(workspaceId: string, userId: string): Promise<EffectiveRole | null> {
    const k = `${workspaceId}:${userId}`;
    const hit = this.cache.get(k);
    if (hit && hit.expires > Date.now()) return hit.value;

    const member = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      include: { roleRef: true },
    });
    if (!member) {
      this.cache.delete(k);
      return null;
    }

    const legacyKey = (member.role ?? "").toLowerCase();
    let role: RoleRow | null = member.roleRef ?? null;
    // A system roleId that disagrees with the legacy role string is stale:
    // deployed code (and any path that only writes `role`) can demote or
    // promote a member without touching roleId. The legacy string wins for
    // system roles; a custom role (isSystem false) always wins.
    if (role && role.isSystem === true && role.key !== legacyKey) role = null;
    if (!role) role = await this.systemRole(workspaceId, legacyKey);

    const value: EffectiveRole = role
      ? {
          roleId: role.id,
          key: role.key,
          name: role.name,
          nameAr: role.nameAr,
          permissions: sanitizePermissions(role.permissions),
          conversationVisibility: role.conversationVisibility === "assigned" ? "assigned" : "all",
        }
      : // An unknown legacy role string: least privilege.
        { roleId: null, key: null, name: member.role, nameAr: member.role, permissions: {}, conversationVisibility: "all" };

    this.cache.set(k, { value, expires: Date.now() + TTL_MS });
    return value;
  }

  can(eff: EffectiveRole | null | undefined, permission: Permission | string): boolean {
    return !!eff && hasPermission(eff.permissions, permission);
  }

  /** Drops cached roles for one member, or for the whole workspace. */
  invalidate(workspaceId: string, userId?: string): void {
    if (userId) {
      this.cache.delete(`${workspaceId}:${userId}`);
      return;
    }
    const prefix = `${workspaceId}:`;
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  /** Creates any missing system roles for a workspace (idempotent). */
  async ensureSystemRoles(workspaceId: string): Promise<void> {
    await this.prisma.role.createMany({
      data: SYSTEM_ROLE_KEYS.map((key) => ({
        workspaceId,
        key,
        name: SYSTEM_ROLES[key].name,
        nameAr: SYSTEM_ROLES[key].nameAr,
        isSystem: true,
        permissions: SYSTEM_ROLES[key].permissions as Prisma.InputJsonValue,
        conversationVisibility: SYSTEM_ROLES[key].conversationVisibility,
      })),
      skipDuplicates: true,
    });
  }

  /** Id of the workspace's system role for a legacy role string (creating
   *  the system roles if missing), or null for an unknown string. */
  async systemRoleId(workspaceId: string, legacyRole: string): Promise<string | null> {
    return (await this.systemRole(workspaceId, legacyRole.toLowerCase()))?.id ?? null;
  }

  private async systemRole(workspaceId: string, key: string): Promise<RoleRow | null> {
    if (!(SYSTEM_ROLE_KEYS as readonly string[]).includes(key)) return null;
    const found = await this.findSystemRole(workspaceId, key);
    if (found) return found;
    await this.ensureSystemRoles(workspaceId);
    return this.findSystemRole(workspaceId, key);
  }

  /** The tenancy extension rewrites `where.workspaceId` to the request's
   *  workspace when a context is active. If a caller asks about another
   *  workspace (e.g. /workspaces/:id/... with :id ≠ the JWT workspace), a
   *  row from the wrong workspace must never be returned. */
  private async findSystemRole(workspaceId: string, key: string): Promise<RoleRow | null> {
    const found = await this.prisma.role.findFirst({ where: { workspaceId, key } });
    if (found && found.workspaceId !== workspaceId) return null;
    return found;
  }
}
