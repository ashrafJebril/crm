import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { KewyIdentitySync } from "../kewy-identity/kewy-identity.sync";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { sanitizePermissions, type PermissionsJson } from "../permissions/catalog";
import { isEffectiveOwner } from "../permissions/member-role";
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly kewySync: KewyIdentitySync,
    private readonly permissions: PermissionService,
  ) {}

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

  async addMember(workspaceId: string, dto: AddMemberDto, actor: Actor) {
    const exists = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: dto.userId, workspaceId } },
    });
    if (exists) throw new ConflictException("Already a member");
    const target = await this.resolveTarget(workspaceId, { role: dto.role });
    await this.authorizeAssignment(workspaceId, actor, target);
    const roleId = target.roleId;
    return this.prisma.workspaceMember.create({
      data: { userId: dto.userId, workspaceId, role: dto.role, roleId },
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
  async inviteByEmail(workspaceId: string, dto: InviteByEmailDto, actor: Actor) {
    // Authorize the role before provisioning anything.
    const target = await this.resolveTarget(workspaceId, { role: dto.role });
    await this.authorizeAssignment(workspaceId, actor, target);
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
      const created = user;
      await this.kewySync.userCreated(created, () =>
        this.prisma.user.delete({ where: { id: created.id } }),
      );
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
        // Set by the inviter, not the user: crm-only in Kewy (see passwordReset).
        await this.kewySync.passwordReset(user, hashed);
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

    const roleId = target.roleId;
    const member = await this.prisma.workspaceMember.create({
      data: { userId: user.id, workspaceId, role: dto.role, roleId },
    });

    return {
      member,
      created: provisionedPassword !== undefined,
      tempPassword: provisionedPassword,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /**
   * The role a request asks for: a roleId (system or custom, must belong to
   * this workspace) or a legacy system role string. `legacyRole` is what old
   * code reads from WorkspaceMember.role: the system key, or "agent" for a
   * custom role. The row check also guards against the tenancy extension
   * rewriting workspaceId on the role query.
   */
  private async resolveTarget(
    workspaceId: string,
    dto: { role?: string; roleId?: string },
  ): Promise<{ legacyRole: string; roleId: string | null; permissions: PermissionsJson }> {
    if (dto.role && dto.roleId) throw new BadRequestException("Send role or roleId, not both");
    if (dto.roleId) {
      const role = await this.prisma.role.findFirst({ where: { id: dto.roleId, workspaceId } });
      if (!role || role.workspaceId !== workspaceId) throw new NotFoundException("Role not found");
      return {
        legacyRole: role.isSystem && role.key ? role.key : "agent",
        roleId: role.id,
        permissions: sanitizePermissions(role.permissions),
      };
    }
    if (dto.role) {
      // Keep roleId in step with the legacy string (SP-25), so a stale system
      // roleId can never outrank a demotion.
      const row = await this.permissions.systemRoleRow(workspaceId, dto.role);
      return {
        legacyRole: dto.role,
        roleId: row?.id ?? null,
        permissions: row ? sanitizePermissions(row.permissions) : {},
      };
    }
    throw new BadRequestException("role or roleId is required");
  }

  /** Only an owner may hand out the owner role, and nobody may hand out
   *  permissions they do not hold themselves. */
  private async authorizeAssignment(
    workspaceId: string,
    actor: Actor,
    target: { legacyRole: string; permissions: PermissionsJson },
  ) {
    if (target.legacyRole === "owner") {
      await this.permissions.assertOwner(workspaceId, actor, "Only an owner can assign the owner role");
    }
    await this.permissions.assertCanGrant(workspaceId, actor, target.permissions);
  }

  /** Member row of THIS workspace (explicit post-check: never trust a row
   *  that came back for another workspace). */
  private async findMember(db: Pick<PrismaService, "workspaceMember">, workspaceId: string, userId: string) {
    const m = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      include: { roleRef: true },
    });
    if (!m || m.workspaceId !== workspaceId) throw new NotFoundException("Member not found");
    return m;
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    dto: UpdateMemberRoleDto,
    actor: Actor,
  ) {
    // Last-owner check and write share one serializable transaction.
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const m = await this.findMember(tx, workspaceId, userId);
        const target = await this.resolveTarget(workspaceId, dto);
        await this.authorizeAssignment(workspaceId, actor, target);
        if (isEffectiveOwner(m)) {
          await this.permissions.assertOwner(workspaceId, actor, "Only an owner can change an owner's role");
          if (target.legacyRole !== "owner") await this.assertAnotherOwner(tx, workspaceId, m.id);
        }
        return tx.workspaceMember.update({
          where: { id: m.id },
          data: { role: target.legacyRole, roleId: target.roleId },
        });
      },
      { isolationLevel: "Serializable" },
    );
    this.permissions.invalidate(workspaceId, userId);
    return updated;
  }

  /** The workspace must keep at least one member whose effective role is owner. */
  private async assertAnotherOwner(
    db: Pick<PrismaService, "workspaceMember">,
    workspaceId: string,
    exceptMemberId: string,
  ) {
    const others = await db.workspaceMember.findMany({
      where: { workspaceId, id: { not: exceptMemberId } },
      include: { roleRef: true },
    });
    if (!others.filter((o) => o.workspaceId === workspaceId).some((o) => isEffectiveOwner(o))) {
      throw new BadRequestException("A workspace must keep at least one owner");
    }
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
    actor: Actor,
  ) {
    const m = await this.findMember(this.prisma, workspaceId, userId);
    if (isEffectiveOwner(m)) {
      await this.permissions.assertOwner(workspaceId, actor, "Only an owner can reset an owner's password");
    }
    if (!actor.isSuperAdmin) {
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
    // Kewy first so a strict failure leaves the local password unchanged.
    await this.kewySync.passwordReset(user, hashed);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
    return {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
      password: dto.password,
    };
  }

  async removeMember(workspaceId: string, userId: string, actor: Actor) {
    await this.prisma.$transaction(
      async (tx) => {
        const m = await this.findMember(tx, workspaceId, userId);
        if (isEffectiveOwner(m)) {
          await this.permissions.assertOwner(workspaceId, actor, "Only an owner can remove an owner");
          await this.assertAnotherOwner(tx, workspaceId, m.id);
        }
        // Only the membership goes; the crm User (and so its Kewy identity) stays.
        // Kewy resolves tenants from workspaces, so there is nothing to sync here.
        await tx.workspaceMember.delete({ where: { id: m.id } });
      },
      { isolationLevel: "Serializable" },
    );
    this.permissions.invalidate(workspaceId, userId);
    return { ok: true };
  }
}
