import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Invitation, Prisma } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { sanitizePermissions } from "../permissions/catalog";
import { AuditService } from "../audit/audit.service";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";
import { inviteEmail } from "../email/templates/invite";
import { emailLang } from "../email/templates/layout";
import { KewyIdentitySync } from "../kewy-identity/kewy-identity.sync";
import { workspaceContext } from "../common/workspace-context";
import { memberError } from "./member-errors";
import { INVITE_RESEND_GAP_MS, INVITE_RESEND_MAX, INVITE_TTL_MS, PASSWORD_MIN } from "./members-constants";
import { appPublicUrl, hashToken, isTokenShape, newToken } from "./token-hash";

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export const INVITATION_STATUSES: readonly InvitationStatus[] = ["pending", "accepted", "revoked", "expired"];

export interface InvitationDto {
  id: string;
  email: string;
  role: { id: string; name: string; nameAr: string } | null;
  status: InvitationStatus;
  invitedBy: { id: string; name: string } | null;
  expiresAt: Date;
  lastSentAt: Date;
  sendCount: number;
  createdAt: Date;
}

export interface CreateInvitationInput {
  email: string;
  roleId: string;
  lang?: "ar" | "en";
}

/** `link` is present only when email is off (ruling 1): shown once to the
 *  inviter, never stored or logged. */
export interface InvitationWriteResult {
  invitation: InvitationDto;
  link?: string;
  emailSent: boolean;
}

/** Who accepted, where: the caller issues the session (AuthService). */
export interface AcceptResult {
  userId: string;
  workspaceId: string;
  /** The invited role was deleted meanwhile: joined as viewer. */
  rolePending: boolean;
}

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];
type InvitationRow = Invitation & {
  role?: { id: string; name: string; nameAr: string } | null;
  invitedBy?: { id: string; name: string } | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(email: unknown): string {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(e) || e.length > 254) throw memberError("invitations.invalid_email");
  return e;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

/** Runs `fn` outside the request's tenancy context: the invited workspace is
 *  not the caller's JWT workspace, and Role lookups must not be rewritten. */
function outsideTenancy<T>(fn: () => Promise<T>): Promise<T> {
  return workspaceContext.exit(fn);
}

/**
 * SP-26 email invitations. Tokens are 32 random bytes (base64url); only the
 * sha256 is stored. Consumption is one conditional update (single use under
 * concurrency); every invalid token answers the same 410. Nothing here logs
 * a token, a link, a password or an email body.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  /** Injectable clock for specs. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly kewySync: KewyIdentitySync,
  ) {}

  statusOf(inv: Pick<Invitation, "acceptedAt" | "revokedAt" | "expiresAt">, now = this.now()): InvitationStatus {
    if (inv.acceptedAt) return "accepted";
    if (inv.revokedAt) return "revoked";
    if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
    return "pending";
  }

  toDto(inv: InvitationRow, now = this.now()): InvitationDto {
    return {
      id: inv.id,
      email: inv.email,
      role: inv.role ? { id: inv.role.id, name: inv.role.name, nameAr: inv.role.nameAr } : null,
      status: this.statusOf(inv, now),
      invitedBy: inv.invitedBy ? { id: inv.invitedBy.id, name: inv.invitedBy.name } : null,
      expiresAt: inv.expiresAt,
      lastSentAt: inv.lastSentAt,
      sendCount: inv.sendCount,
      createdAt: inv.createdAt,
    };
  }

  private readonly include = {
    role: { select: { id: true, name: true, nameAr: true } },
    invitedBy: { select: { id: true, name: true } },
  } as const;

  /** GET /workspaces/:id/invitations?status= */
  async list(workspaceId: string, status: string | undefined) {
    const want = status === "all" ? null : INVITATION_STATUSES.includes(status as InvitationStatus) ? (status as InvitationStatus) : "pending";
    const rows = (await this.prisma.invitation.findMany({
      where: { workspaceId },
      include: this.include,
      orderBy: { createdAt: "desc" },
    })) as InvitationRow[];
    const now = this.now();
    const all = rows.filter((r) => r.workspaceId === workspaceId).map((r) => this.toDto(r, now));
    const counts = { pending: 0, accepted: 0, revoked: 0, expired: 0, all: all.length };
    for (const i of all) counts[i.status]++;
    return { items: want ? all.filter((i) => i.status === want) : all, counts };
  }

  /** Only an owner invites into the owner role, and nobody invites into a
   *  role holding permissions they lack (403 invitations.role_above_actor). */
  private async assertInvitable(
    workspaceId: string,
    actor: Actor,
    role: { key: string | null; isSystem: boolean; permissions: Prisma.JsonValue; conversationVisibility: string },
  ): Promise<void> {
    try {
      if (role.isSystem && role.key === "owner") {
        await this.permissions.assertOwner(workspaceId, actor, "Only an owner can invite an owner");
      }
      await this.permissions.assertCanGrant(
        workspaceId,
        actor,
        sanitizePermissions(role.permissions),
        role.conversationVisibility === "assigned" ? "assigned" : "all",
      );
    } catch (e) {
      if (e instanceof ForbiddenException) throw memberError("invitations.role_above_actor");
      throw e;
    }
  }

  private async roleOf(workspaceId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, workspaceId } });
    if (!role || role.workspaceId !== workspaceId) throw new NotFoundException("Role not found");
    return role;
  }

  /** POST /workspaces/:id/invitations */
  async create(workspaceId: string, input: CreateInvitationInput, actor: Actor): Promise<InvitationWriteResult> {
    const email = normaliseEmail(input.email);
    const role = await this.roleOf(workspaceId, input.roleId);
    await this.assertInvitable(workspaceId, actor, role);

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: existing.id, workspaceId } },
      });
      if (member && member.workspaceId === workspaceId) throw memberError("invitations.already_member");
    }

    const token = newToken();
    const now = this.now();
    const inv = await this.prisma.$transaction(async (tx) => {
      // One pending invitation per (workspace, email): serialise the check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite:${workspaceId}:${email}`}))`;
      const pending = await tx.invitation.findFirst({
        where: { workspaceId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      });
      if (pending) throw memberError("invitations.pending_exists");
      const created = await tx.invitation.create({
        data: {
          workspaceId,
          email,
          roleId: role.id,
          lang: emailLang(input.lang),
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          invitedById: actor.userId,
          sendCount: 1,
          lastSentAt: now,
          createdAt: now,
        },
        include: this.include,
      });
      await this.audit.record(tx, {
        workspaceId,
        actorId: actor.userId,
        action: "invitation.created",
        targetKind: "invitation",
        targetId: created.id,
        meta: { email, roleId: role.id },
      });
      return created as InvitationRow;
    });
    return this.deliver(inv, token);
  }

  /** POST /workspaces/:id/invitations/:invId/resend: rotates the token (the
   *  old link dies), at most INVITE_RESEND_MAX sends, one per minute. */
  async resend(workspaceId: string, invId: string, actor: Actor): Promise<InvitationWriteResult> {
    const inv = await this.findInWorkspace(workspaceId, invId);
    if (inv.acceptedAt || inv.revokedAt) throw memberError("invitations.invalid");
    const now = this.now();
    if (inv.sendCount >= INVITE_RESEND_MAX || now.getTime() - inv.lastSentAt.getTime() < INVITE_RESEND_GAP_MS) {
      throw memberError("invitations.resend_limited");
    }
    // The inviter's grant may have changed since: check it again.
    if (inv.roleId) await this.assertInvitable(workspaceId, actor, await this.roleOf(workspaceId, inv.roleId));

    const token = newToken();
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.invitation.updateMany({
        where: { id: inv.id, workspaceId, sendCount: inv.sendCount, acceptedAt: null, revokedAt: null },
        data: {
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          sendCount: { increment: 1 },
          lastSentAt: now,
        },
      });
      // Lost a race with another resend, an accept or a revoke.
      if (res.count === 0) throw memberError("invitations.resend_limited");
      await this.audit.record(tx, {
        workspaceId,
        actorId: actor.userId,
        action: "invitation.resent",
        targetKind: "invitation",
        targetId: inv.id,
        meta: { email: inv.email, sendCount: inv.sendCount + 1 },
      });
      return (await tx.invitation.findUnique({ where: { id: inv.id }, include: this.include })) as InvitationRow;
    });
    return this.deliver(updated, token);
  }

  /** DELETE /workspaces/:id/invitations/:invId (idempotent). */
  async revoke(workspaceId: string, invId: string, actor: Actor): Promise<{ ok: true }> {
    const inv = await this.findInWorkspace(workspaceId, invId);
    if (inv.acceptedAt) throw memberError("invitations.invalid");
    if (inv.revokedAt) return { ok: true };
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.invitation.updateMany({
        where: { id: inv.id, workspaceId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      if (res.count === 0) return;
      await this.audit.record(tx, {
        workspaceId,
        actorId: actor.userId,
        action: "invitation.revoked",
        targetKind: "invitation",
        targetId: inv.id,
        meta: { email: inv.email },
      });
    });
    return { ok: true };
  }

  private async findInWorkspace(workspaceId: string, invId: string): Promise<InvitationRow> {
    const inv = (await this.prisma.invitation.findFirst({ where: { id: invId, workspaceId }, include: this.include })) as InvitationRow | null;
    if (!inv || inv.workspaceId !== workspaceId) throw memberError("invitations.not_found");
    return inv;
  }

  /** Email the link, or (email off) return it once to the inviter. */
  private async deliver(inv: InvitationRow, token: string): Promise<InvitationWriteResult> {
    const link = `${appPublicUrl()}/invite?token=${encodeURIComponent(token)}`;
    const invitation = this.toDto(inv);
    if (!this.email.enabled) return { invitation, link, emailSent: false };
    try {
      const [ws, inviter] = await Promise.all([
        this.prisma.workspace.findUnique({ where: { id: inv.workspaceId }, select: { name: true } }),
        inv.invitedById ? this.prisma.user.findUnique({ where: { id: inv.invitedById }, select: { name: true } }) : null,
      ]);
      const lang = emailLang(inv.lang);
      await this.email.send(
        inviteEmail({
          to: inv.email,
          lang,
          workspaceName: ws?.name ?? "",
          inviterName: inviter?.name ?? null,
          roleName: inv.role ? (lang === "ar" ? inv.role.nameAr : inv.role.name) : null,
          link,
          expiresAt: inv.expiresAt,
        }),
      );
      return { invitation, emailSent: true };
    } catch (e) {
      // The provider failed: the invitation stays (resend works). No link,
      // address or body is logged.
      this.logger.warn(`invitation ${inv.id} email failed: ${(e as Error)?.name ?? "Error"}`);
      return { invitation, emailSent: false };
    }
  }

  /** A pending invitation by token, or the one 410 for every invalid token. */
  private async pendingByToken(token: unknown): Promise<Invitation> {
    if (!isTokenShape(token)) throw memberError("invitations.invalid");
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!inv || this.statusOf(inv) !== "pending") throw memberError("invitations.invalid");
    return inv;
  }

  /** GET /invitations/preview?token= (public). */
  async preview(token: unknown) {
    const inv = await this.pendingByToken(token);
    const [ws, role, inviter, account] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: inv.workspaceId }, select: { id: true, name: true } }),
      inv.roleId ? this.prisma.role.findFirst({ where: { id: inv.roleId, workspaceId: inv.workspaceId } }) : null,
      inv.invitedById ? this.prisma.user.findUnique({ where: { id: inv.invitedById }, select: { name: true } }) : null,
      this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } }),
    ]);
    if (!ws) throw memberError("invitations.invalid");
    return {
      id: inv.id,
      email: inv.email,
      lang: emailLang(inv.lang),
      workspace: { id: ws.id, name: ws.name },
      role: role && role.workspaceId === inv.workspaceId ? { id: role.id, name: role.name, nameAr: role.nameAr } : null,
      invitedBy: inviter ? { name: inviter.name } : null,
      expiresAt: inv.expiresAt,
      accountExists: !!account,
    };
  }

  /** GET /auth/invitations: the signed-in user's pending invitations. */
  async listForUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return [];
    const now = this.now();
    const rows = await this.prisma.invitation.findMany({
      where: { email: user.email.toLowerCase(), acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      include: { ...this.include, workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      ...this.toDto(r as InvitationRow, now),
      workspace: (r as { workspace?: { id: string; name: string } }).workspace ?? null,
    }));
  }

  /** POST /invitations/accept (public, signed out). */
  async acceptWithToken(input: { token: unknown; name?: string; password?: string }): Promise<AcceptResult> {
    return outsideTenancy(async () => {
      const inv = await this.pendingByToken(input.token);
      const account = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
      if (account) throw memberError("invitations.sign_in_required");
      if (typeof input.password !== "string" || input.password.length < PASSWORD_MIN) {
        throw new BadRequestException({ statusCode: 400, message: "auth.password_too_short" });
      }
      const name = (input.name?.trim() || inv.email.split("@")[0]).slice(0, 80);
      const hashed = await bcrypt.hash(input.password, 10);
      const tokenHash = inv.tokenHash;
      const out = await this.prisma.$transaction(async (tx) => {
        await this.consume(tx, inv, { tokenHash });
        const user = await tx.user.create({
          data: { email: inv.email, name, password: hashed, role: "Agent", initials: initialsOf(name), color: "180", status: "offline" },
        });
        // Mirror to Kewy inside the transaction: a strict refusal rolls back.
        await this.kewySync.userCreated(user);
        const rolePending = await this.join(tx, inv, user.id);
        return { userId: user.id, workspaceId: inv.workspaceId, rolePending };
      });
      this.permissions.invalidate(out.workspaceId, out.userId);
      return out;
    });
  }

  /** POST /auth/invitations/:invId/accept (signed in): the invitation must be
   *  for the signed-in user's email. */
  async acceptSignedIn(userId: string, invId: string): Promise<AcceptResult> {
    return outsideTenancy(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
      const inv = await this.prisma.invitation.findUnique({ where: { id: invId } });
      if (!user || !inv) throw memberError("invitations.not_found");
      if (this.statusOf(inv) !== "pending") throw memberError("invitations.invalid");
      if (user.email.toLowerCase() !== inv.email) throw memberError("invitations.email_mismatch");
      const out = await this.prisma.$transaction(async (tx) => {
        await this.consume(tx, inv, {});
        const rolePending = await this.join(tx, inv, user.id);
        return { userId: user.id, workspaceId: inv.workspaceId, rolePending };
      });
      this.permissions.invalidate(out.workspaceId, out.userId);
      return out;
    });
  }

  /** The single-use step: exactly one caller wins the conditional update. */
  private async consume(tx: Tx, inv: Invitation, guard: { tokenHash?: string }): Promise<void> {
    const res = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: this.now() }, ...guard },
      data: { acceptedAt: this.now() },
    });
    if (res.count === 0) throw memberError("invitations.invalid");
  }

  /** Adds (or keeps) the membership with the invited role; a role deleted
   *  meanwhile (roleId set null) joins as viewer with `rolePending`. */
  private async join(tx: Tx, inv: Invitation, userId: string): Promise<boolean> {
    const role = inv.roleId ? await tx.role.findFirst({ where: { id: inv.roleId, workspaceId: inv.workspaceId } }) : null;
    const usable = role && role.workspaceId === inv.workspaceId ? role : null;
    const rolePending = !usable;
    let legacyRole = "viewer";
    let roleId: string | null = null;
    if (usable) {
      legacyRole = usable.isSystem && usable.key ? usable.key : "viewer";
      roleId = usable.id;
    } else {
      const viewer = await tx.role.findFirst({ where: { workspaceId: inv.workspaceId, key: "viewer" } });
      roleId = viewer && viewer.workspaceId === inv.workspaceId ? viewer.id : null;
    }
    await tx.workspaceMember.upsert({
      where: { userId_workspaceId: { userId, workspaceId: inv.workspaceId } },
      create: { userId, workspaceId: inv.workspaceId, role: legacyRole, roleId },
      // Already a member (added meanwhile): the existing role stays.
      update: {},
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedById: userId } });
    await this.audit.record(tx, {
      workspaceId: inv.workspaceId,
      actorId: userId,
      action: "invitation.accepted",
      targetKind: "invitation",
      targetId: inv.id,
      meta: { email: inv.email, roleId, rolePending },
    });
    return rolePending;
  }
}
