import { Injectable, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/auth.guard";
import { SuspendWorkspaceDto, UpdateWorkspaceAdminDto } from "./admin.dto";

/** SaaS-operator service. Uses the UNSCOPED `prisma.raw` client so it can
 *  read/write across tenants. Reserved for super-admin endpoints. */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async listWorkspaces() {
    const wss = await this.prisma.raw.workspace.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        members: {
          where: { role: "owner" },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
          take: 1,
        },
        _count: {
          select: {
            members: true,
            contacts: true,
            conversations: true,
            mentions: true,
            tickets: true,
          },
        },
      },
    });
    return wss.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      plan: w.plan,
      lang: w.lang,
      timezone: w.timezone,
      suspendedAt: w.suspendedAt,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      owner: w.members[0]?.user ?? null,
      counts: {
        members: w._count.members,
        contacts: w._count.contacts,
        conversations: w._count.conversations,
        mentions: w._count.mentions,
        tickets: w._count.tickets,
      },
    }));
  }

  async getWorkspace(id: string) {
    const ws = await this.prisma.raw.workspace.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                initials: true,
                color: true,
                status: true,
                isSuperAdmin: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        integrations: {
          select: {
            id: true,
            platform: true,
            pageId: true,
            pageName: true,
            expiresAt: true,
            lastFetchedAt: true,
          },
        },
        _count: {
          select: {
            contacts: true,
            conversations: true,
            messages: true,
            mentions: true,
            tickets: true,
            campaigns: true,
            templates: true,
          },
        },
      },
    });
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }

  async updateWorkspace(id: string, dto: UpdateWorkspaceAdminDto) {
    await this.requireWorkspace(id);
    return this.prisma.raw.workspace.update({ where: { id }, data: dto });
  }

  async suspendWorkspace(id: string, dto: SuspendWorkspaceDto) {
    await this.requireWorkspace(id);
    return this.prisma.raw.workspace.update({
      where: { id },
      data: { suspendedAt: dto.suspended ? new Date() : null },
    });
  }

  /** Issues a short-lived JWT scoped to the target workspace, marked
   *  `impersonating: true`. The `sub` stays as the super-admin's userId so
   *  audit logs attribute actions correctly. */
  async impersonateWorkspace(superAdminUserId: string, workspaceId: string) {
    const admin = await this.prisma.raw.user.findUnique({
      where: { id: superAdminUserId },
    });
    if (!admin?.isSuperAdmin) {
      throw new NotFoundException("Super-admin user not found");
    }
    await this.requireWorkspace(workspaceId);

    const payload: JwtPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      workspaceId,
      impersonating: true,
      // intentionally NOT setting isSuperAdmin — impersonation should not
      // carry super-admin powers; super-admin must log back in to exit.
    };
    const token = await this.jwt.signAsync(payload, { expiresIn: "30m" });
    return { token, expiresInSec: 1800, workspaceId };
  }

  async listUsers() {
    const users = await this.prisma.raw.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        initials: true,
        color: true,
        status: true,
        role: true,
        isSuperAdmin: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });
    return users.map((u) => ({
      ...u,
      workspaceCount: u._count.memberships,
      _count: undefined,
    }));
  }

  private async requireWorkspace(id: string) {
    const ws = await this.prisma.raw.workspace.findUnique({ where: { id } });
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }
}
