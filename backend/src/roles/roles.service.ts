import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { sanitizePermissions, validatePermissions } from "../permissions/catalog";
import { resolveMemberRole } from "../permissions/member-role";
import { CreateRoleDto, UpdateRoleDto } from "./roles.dto";

const SYSTEM_ORDER = ["owner", "admin", "agent", "viewer"];

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** Roles of the workspace with `memberCount` (effective role, so members
   *  still on the legacy string count towards their system role). */
  async list(workspaceId: string) {
    await this.permissions.ensureSystemRoles(workspaceId);
    const [roles, members] = await Promise.all([
      this.prisma.role.findMany({ where: { workspaceId } }),
      this.prisma.workspaceMember.findMany({
        where: { workspaceId },
        select: { role: true, roleId: true, roleRef: true },
      }),
    ]);
    const systemByKey = new Map(
      roles.filter((r) => r.isSystem && r.key).map((r) => [r.key as string, r]),
    );
    const counts = new Map<string, number>();
    for (const m of members) {
      const r = resolveMemberRole(m, systemByKey);
      if (r) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    }
    const rank = (r: { key: string | null; isSystem: boolean }) =>
      r.isSystem && r.key ? SYSTEM_ORDER.indexOf(r.key) : SYSTEM_ORDER.length;
    return roles
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        nameAr: r.nameAr,
        isSystem: r.isSystem,
        permissions: sanitizePermissions(r.permissions),
        conversationVisibility: r.conversationVisibility,
        memberCount: counts.get(r.id) ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  async create(workspaceId: string, dto: CreateRoleDto, actor: Actor) {
    const permissions = validatePermissions(dto.permissions);
    await this.permissions.assertCanGrant(workspaceId, actor, permissions, dto.conversationVisibility ?? "all");
    await this.assertNameFree(workspaceId, dto.name);
    const role = await this.prisma.role.create({
      data: {
        workspaceId,
        key: null,
        name: dto.name.trim(),
        nameAr: dto.nameAr.trim(),
        isSystem: false,
        permissions: permissions as Prisma.InputJsonValue,
        conversationVisibility: dto.conversationVisibility ?? "all",
      },
    });
    return { ...role, permissions, memberCount: 0 };
  }

  async update(workspaceId: string, id: string, dto: UpdateRoleDto, actor: Actor) {
    const role = await this.find(this.prisma, workspaceId, id);
    if (role.isSystem && role.key === "owner") {
      throw new BadRequestException("The Owner role cannot be modified");
    }
    const data: Prisma.RoleUpdateInput = {};
    if (dto.permissions !== undefined || dto.conversationVisibility !== undefined) {
      const permissions = dto.permissions !== undefined ? validatePermissions(dto.permissions) : {};
      await this.permissions.assertCanGrant(workspaceId, actor, permissions, dto.conversationVisibility);
      if (dto.permissions !== undefined) data.permissions = permissions as Prisma.InputJsonValue;
    }
    if (dto.name !== undefined && dto.name.trim() !== role.name) {
      await this.assertNameFree(workspaceId, dto.name, id);
      data.name = dto.name.trim();
    }
    if (dto.nameAr !== undefined) data.nameAr = dto.nameAr.trim();
    if (dto.conversationVisibility !== undefined) {
      data.conversationVisibility = dto.conversationVisibility;
    }
    // `key` is never writable: it is not in the DTO and not copied here.
    const updated = await this.prisma.role.update({ where: { id }, data });
    // Every member of this role sees the change at once, not after the TTL.
    this.permissions.invalidate(workspaceId);
    return { ...updated, permissions: sanitizePermissions(updated.permissions) };
  }

  /** The in-use check and the delete run in one transaction. */
  async remove(workspaceId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const role = await this.find(tx, workspaceId, id);
      if (role.isSystem) throw new BadRequestException("System roles cannot be deleted");
      const members = await tx.workspaceMember.count({ where: { workspaceId, roleId: id } });
      if (members > 0) {
        throw new ConflictException({
          statusCode: 409,
          message: "Role is assigned to members",
          members,
        });
      }
      await tx.role.delete({ where: { id } });
      return { ok: true };
    });
  }

  /** Role of this workspace, or 404 (another workspace's role id is a 404 too). */
  private async find(db: Pick<PrismaService, "role">, workspaceId: string, id: string) {
    const role = await db.role.findFirst({ where: { id, workspaceId } });
    if (!role || role.workspaceId !== workspaceId) throw new NotFoundException("Role not found");
    return role;
  }

  private async assertNameFree(workspaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.role.findFirst({
      where: { workspaceId, name: name.trim(), ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw new ConflictException("A role with this name already exists");
  }
}
