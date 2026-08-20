import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { seedWorkspaceDefaults } from "./workspace-defaults";
import {
  AddMemberDto,
  CreateWorkspaceDto,
  InviteByEmailDto,
  ResetMemberPasswordDto,
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
  WorkspaceRole,
} from "./workspaces.dto";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    // Hide suspended workspaces from the switcher dropdown — a suspended
    // tenant isn't usable, and listing them makes the picker noisy. They're
    // still visible (and unsuspendable) from the super-admin portal.
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { suspendedAt: null } },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      timezone: m.workspace.timezone,
      lang: m.workspace.lang,
      plan: m.workspace.plan,
      role: m.role as WorkspaceRole,
    }));
  }

  async get(id: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id } });
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }

  async create(dto: CreateWorkspaceDto, ownerUserId: string) {
    const baseSlug = toSlug(dto.name);
    let slug = baseSlug;
    let suffix = 0;
    while (await this.prisma.workspace.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }
    // Wrapped in a transaction so we never leave an orphaned Workspace if the
    // owner-membership insert fails (e.g. invalid userId FK).
    return this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name: dto.name,
          slug,
          timezone: dto.timezone ?? "Asia/Riyadh",
          lang: dto.lang ?? "ar",
        },
      });
      await tx.workspaceMember.create({
        data: { userId: ownerUserId, workspaceId: ws.id, role: "owner" },
      });
      // Same defaults every workspace gets: sales pipeline + stages (which the
      // inbound-message automation needs) and the starter/stage smart groups.
      await seedWorkspaceDefaults(tx, ws.id);
      return ws;
    });
  }

  async update(id: string, dto: UpdateWorkspaceDto) {
    await this.get(id);
    return this.prisma.workspace.update({ where: { id }, data: dto });
  }

  async requireMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new ForbiddenException("Not a member of this workspace");
    return m.role as WorkspaceRole;
  }

  async listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        // Project only safe user fields — never leak password hash via this API.
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            initials: true,
            color: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMember(workspaceId: string, dto: AddMemberDto) {
    const exists = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: dto.userId, workspaceId } },
    });
    if (exists) throw new ConflictException("Already a member");
    return this.prisma.workspaceMember.create({
      data: { userId: dto.userId, workspaceId, role: dto.role },
    });
  }

  /**
   * Invite by email. If the email matches an existing tkana user, just adds
   * them as a member (their existing password is unchanged). If the email
   * is new AND the caller supplied `name` + `password`, creates the user
   * on the fly and adds them — the caller can then hand the credentials
   * to the teammate.
   *
   * Returns `{ memberId, created, tempPassword? }` so the UI can show the
   * password once when a new account was provisioned.
   */
  async inviteByEmail(workspaceId: string, dto: InviteByEmailDto) {
    const email = dto.email.toLowerCase().trim();
    let user = await this.prisma.user.findUnique({ where: { email } });
    let provisionedPassword: string | undefined;

    if (!user) {
      // Create new user with the supplied name + password
      if (!dto.name || !dto.password) {
        throw new NotFoundException(
          "No tkana user with that email. Provide `name` and `password` to create them on the fly.",
        );
      }
      const hashed = await bcrypt.hash(dto.password, 10);
      user = await this.prisma.user.create({
        data: {
          email,
          name: dto.name,
          password: hashed,
          role: dto.role === "owner" ? "Owner" : dto.role === "admin" ? "Manager" : "Agent",
          initials: initialsOf(dto.name),
          color: "180",
          status: "offline",
        },
      });
      provisionedPassword = dto.password;
    } else if (dto.password) {
      // User row already existed (e.g. previously removed-then-re-added). If
      // they don't belong to any other workspace, treat this invite as a
      // re-provision and apply the supplied password so the inviter's modal
      // matches reality. Cross-tenant guard: if they're in another workspace,
      // we can't safely reset — refuse to touch the password and just add the
      // membership (caller can use the Reset password button if needed and
      // the safety rail allows).
      const otherMemberships = await this.prisma.workspaceMember.count({
        where: { userId: user.id, workspaceId: { not: workspaceId } },
      });
      if (otherMemberships === 0) {
        const hashed = await bcrypt.hash(dto.password, 10);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { password: hashed },
        });
        provisionedPassword = dto.password;
      }
    }

    const exists = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (exists) throw new ConflictException("Already a member");

    const member = await this.prisma.workspaceMember.create({
      data: { userId: user.id, workspaceId, role: dto.role },
    });

    return {
      member,
      created: provisionedPassword !== undefined,
      tempPassword: provisionedPassword,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    return this.prisma.workspaceMember.update({
      where: { id: m.id },
      data: { role: dto.role },
    });
  }

  /**
   * Reset a workspace member's login password. Owner/admin only (enforced at
   * controller). Cross-tenant safety rail: refuses if the target user is
   * also a member of other workspaces — they're not "ours" to reset and a
   * single-tenant owner could take over their access elsewhere. Super-admins
   * (tkana-internal staff) bypass the rail since they already have a
   * legitimate cross-tenant role.
   */
  async resetMemberPassword(
    workspaceId: string,
    userId: string,
    dto: ResetMemberPasswordDto,
    options: { isSuperAdmin?: boolean } = {},
  ) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    if (!options.isSuperAdmin) {
      const otherMemberships = await this.prisma.workspaceMember.count({
        where: { userId, workspaceId: { not: workspaceId } },
      });
      if (otherMemberships > 0) {
        throw new ForbiddenException(
          "User belongs to other workspaces — they must change their own password.",
        );
      }
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    const hashed = await bcrypt.hash(dto.password, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
      password: dto.password,
    };
  }

  async removeMember(workspaceId: string, userId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    await this.prisma.workspaceMember.delete({ where: { id: m.id } });
    return { ok: true };
  }
}
