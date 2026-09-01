import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/auth.guard";
import { seedWorkspaceDefaults } from "../workspaces/workspace-defaults";
import { ProvisionClientDto, SuspendWorkspaceDto, UpdateWorkspaceAdminDto } from "./admin.dto";

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

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

  /**
   * One-shot client onboarding for super-admins: create a fresh User + Workspace
   * + owner WorkspaceMember in a single transaction. The admin chooses the
   * password so they can hand the credentials to the customer directly. The
   * customer can change it later via Settings → Profile.
   */
  async provisionClient(dto: ProvisionClientDto) {
    // Idempotency: Kewy retries a provision whose response it never saw (a
    // timeout after the write succeeded). Returning the existing workspace
    // instead of creating a second one is what makes that retry safe.
    if (dto.kewyWorkspaceId) {
      const already = await this.prisma.raw.workspace.findUnique({
        where: { kewyWorkspaceId: dto.kewyWorkspaceId },
        select: { id: true, name: true, slug: true },
      });
      if (already) {
        const owner = await this.prisma.raw.workspaceMember.findFirst({
          where: { workspaceId: already.id, role: "owner" },
          select: { user: { select: { id: true, email: true, name: true } } },
        });
        return { workspace: already, user: owner?.user ?? null };
      }
    }

    // A returning customer already has a crm User. crm has WorkspaceMember, so
    // one user legitimately spans several workspaces — reuse the row and add a
    // membership rather than rejecting. Previously this threw a 409, which made
    // a second workspace (or any retry) impossible.
    const existing = await this.prisma.raw.user.findFirst({
      where: dto.kewyAccountId
        ? { OR: [{ kewyAccountId: dto.kewyAccountId }, { email: dto.ownerEmail }] }
        : { email: dto.ownerEmail },
    });

    // The one genuine conflict left: the email belongs to somebody who is
    // already linked to a *different* Kewy account. Silently attaching that
    // person's workspaces to this account would be a cross-tenant leak.
    if (
      existing &&
      dto.kewyAccountId &&
      existing.kewyAccountId &&
      existing.kewyAccountId !== dto.kewyAccountId
    ) {
      throw new ConflictException(
        "That email belongs to a user linked to a different Kewy account",
      );
    }

    const baseSlug = toSlug(dto.workspaceName);
    let slug = baseSlug;
    let suffix = 0;
    while (await this.prisma.raw.workspace.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }

    // No password when Kewy provisions: that owner arrives by SSO handoff and
    // never needs a local one. `User.password` is already nullable for exactly
    // this reason (the hjz bridge relies on it too).
    const hashed = dto.ownerPassword
      ? await bcrypt.hash(dto.ownerPassword, 10)
      : null;

    return this.prisma.raw.$transaction(async (tx) => {
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            // Only ever fill in a missing link; never overwrite an existing
            // password or rename a user because a provision call said so.
            data: {
              kewyAccountId: existing.kewyAccountId ?? dto.kewyAccountId ?? null,
              ...(existing.password === null && hashed ? { password: hashed } : {}),
            },
          })
        : await tx.user.create({
            data: {
              email: dto.ownerEmail,
              name: dto.ownerName,
              password: hashed,
              kewyAccountId: dto.kewyAccountId ?? null,
              role: "Owner",
              initials: initialsOf(dto.ownerName),
              color: "210",
              status: "offline",
            },
          });

      const ws = await tx.workspace.create({
        data: {
          name: dto.workspaceName,
          slug,
          timezone: dto.timezone ?? "Asia/Riyadh",
          lang: dto.lang ?? "ar",
          kewyWorkspaceId: dto.kewyWorkspaceId ?? null,
        },
      });

      await tx.workspaceMember.create({
        data: { userId: user.id, workspaceId: ws.id, role: "owner" },
      });

      // Default pipeline + stages + smart groups, inside the same transaction
      // so a client is never provisioned half-configured.
      await seedWorkspaceDefaults(tx, ws.id);

      return {
        workspace: { id: ws.id, name: ws.name, slug: ws.slug },
        user: { id: user.id, email: user.email, name: user.name },
      };
    });
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
