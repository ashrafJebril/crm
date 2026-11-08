import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import { resolveMemberRole } from "../permissions/member-role";

@Controller("team")
export class TeamController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  async list(@CurrentWorkspace() workspaceId: string) {
    await this.permissions.ensureSystemRoles(workspaceId);
    const [members, roles] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { workspaceId },
        include: { user: true, roleRef: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.role.findMany({ where: { workspaceId, isSystem: true } }),
    ]);
    const systemByKey = new Map(roles.filter((r) => r.key).map((r) => [r.key as string, r]));
    return members.map((m) => {
      // Same precedence as PermissionService.effective.
      const role = resolveMemberRole(m, systemByKey);
      return {
        id: m.user.id,
        email: m.user.email,
        name: m.user.name,
        role: m.role, // legacy workspace-scoped role string
        roleId: role?.id ?? null,
        roleName: role?.name ?? m.role,
        roleNameAr: role?.nameAr ?? m.role,
        initials: m.user.initials,
        color: m.user.color,
        status: m.user.status,
      };
    });
  }
}

@Module({ controllers: [TeamController] })
export class TeamModule {}
