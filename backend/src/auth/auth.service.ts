import { emailWhere, normalizeEmail, pickByEmail } from "./email";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { isPaymentLocked } from "../billing/payment-lock";
import { paymentOverdue } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { authSource } from "../kewy-identity/auth-source";
import {
  KewyIdentityClient,
  type KewyAuthResult,
} from "../kewy-identity/kewy-identity.client";
import { KewyIdentitySync } from "../kewy-identity/kewy-identity.sync";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { WorkspaceRole } from "../workspaces/workspaces.dto";
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  SwitchWorkspaceDto,
  UpdateProfileDto,
} from "./dto";
import type { JwtPayload } from "./auth.guard";
import { TwoFactorService } from "./two-factor.service";
import { SessionVersionService } from "./session-version.service";

// The user AND their (non-suspended) memberships, in one query.
const LOGIN_INCLUDE = {
  memberships: {
    where: { workspace: { suspendedAt: null } },
    include: { workspace: true },
    orderBy: { createdAt: "asc" as const },
  },
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
    private readonly kewy: KewyIdentityClient,
    private readonly kewySync: KewyIdentitySync,
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: SessionVersionService,
  ) {}

  /**
   * POST /auth/login. Where the password is checked depends on AUTH_SOURCE
   * (see kewy-identity/auth-source.ts); everything after the check — and the
   * response — is the same in every mode.
   */
  async login(dto: LoginDto, clientIp?: string) {
    const email = normalizeEmail(dto.email);
    const mode = authSource();
    if (mode === "local") return this.loginLocal(email, dto.password, { backfill: true });

    const res = await this.kewy.authenticate({
      identifier: email,
      password: dto.password,
      ...(clientIp ? { clientIp: clientIp.slice(0, 64) } : {}),
    });
    if (res.kind === "ok") return this.loginWithKewy(email, res.data);
    if (res.kind === "rejected") {
      // A definite answer about these credentials: never fall back.
      if (res.code === "INVALID_CREDENTIALS" || res.code === "ACCOUNT_DISABLED") {
        throw new UnauthorizedException("Invalid credentials");
      }
      if (res.code === "RATE_LIMITED" || res.status === 429) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: "Too many login attempts. Please try again later.",
            ...(res.retryAfterSec ? { retryAfterSec: res.retryAfterSec } : {}),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // Anything else (UNAUTHORIZED_PRODUCT, INVALID_BODY, …) is about the
      // call, not the credentials: treat it like an outage.
      this.logger.error(
        `Kewy IdP refused the login call (${res.status} ${res.code}); check KEWY_IDP_URL / KEWY_IDP_SECRET`,
      );
    } else {
      this.logger.warn(`Kewy IdP unreachable for login (${res.reason})`);
    }
    if (mode === "kewy") {
      throw new ServiceUnavailableException(
        "Login is temporarily unavailable. Please try again shortly.",
      );
    }
    this.logger.warn("Falling back to the local password check (AUTH_SOURCE=kewy_with_fallback)");
    return this.loginLocal(email, dto.password, { backfill: false });
  }

  private async loginLocal(email: string, password: string, opts: { backfill: boolean }) {
    // One DB round-trip (user + memberships) plus the bcrypt compare; issue()
    // signs from this row instead of re-fetching.
    // The normalised row first; then any letter case, so accounts stored before emails were normalised still sign in.
    const user =
      (await this.prisma.user.findUnique({ where: { email }, include: LOGIN_INCLUDE })) ??
      (await this.prisma.user.findFirst({ where: emailWhere(email), include: LOGIN_INCLUDE }));
    // SSO-provisioned users have no local password — they come in via
    // POST /auth/sso/exchange, not this endpoint.
    if (!user || !user.password) throw new UnauthorizedException("Invalid credentials");
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");
    if (opts.backfill) this.kewySync.backfill(user);
    return this.finishLogin(user);
  }

  /** Kewy accepted the password: find the crm user it belongs to. */
  private async loginWithKewy(email: string, auth: KewyAuthResult) {
    const ids = auth.identities.map((i) => i.externalUserId);
    const candidates = await this.prisma.user.findMany({
      where: { OR: [...(ids.length ? [{ id: { in: ids } }] : []), emailWhere(email)] },
      include: LOGIN_INCLUDE,
    });
    // Prefer a user Kewy itself linked (in identity order), else the email match.
    const byIdentity = ids
      .map((id) => candidates.find((u) => u.id === id))
      .find((u) => u !== undefined);
    const user = byIdentity ?? pickByEmail(candidates, email);
    if (!user) {
      this.logger.warn(`Kewy account ${auth.accountId} has no crm user`);
      throw new UnauthorizedException("Invalid credentials");
    }
    if (!byIdentity && user.kewyAccountId && user.kewyAccountId !== auth.accountId) {
      // Same email, but this crm user is linked to a different Kewy account.
      // Never sign one person in as another.
      this.logger.warn(
        `crm user ${user.id} is linked to Kewy account ${user.kewyAccountId}, not ${auth.accountId}; refusing email match`,
      );
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.kewyAccountId) this.stampKewyAccount(user.id, auth.accountId);
    this.cacheEntitlements(auth);
    return this.finishLogin(user);
  }

  /** Best-effort: kewyAccountId is @unique, so a clash is skipped, never fatal. */
  private stampKewyAccount(userId: string, accountId: string): void {
    void this.prisma.raw.user
      .updateMany({ where: { id: userId, kewyAccountId: null }, data: { kewyAccountId: accountId } })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not stamp kewyAccountId ${accountId} on user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /**
   * Best-effort: copy each tenant's enabledModules onto the matching crm
   * Workspace (tenant.externalTenantId === Workspace.id). An empty list is
   * skipped: Kewy sends [] when it has no package state, while crm reads NULL
   * as "all modules". plan / suspendedAt are not touched in this phase.
   */
  private cacheEntitlements(auth: KewyAuthResult): void {
    for (const t of auth.tenants) {
      if (!t.externalTenantId || !Array.isArray(t.enabledModules) || !t.enabledModules.length) {
        continue;
      }
      void this.prisma.raw.workspace
        .updateMany({ where: { id: t.externalTenantId }, data: { enabledModules: t.enabledModules } })
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not cache entitlements on workspace ${t.externalTenantId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  /** SP-26: a fresh session after this user's sessionVersion changed
   *  (2FA disable), keeping the current workspace when still a member. */
  async reissue(userId: string, workspaceId?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.workspaces.listForUser(userId);
    const active = workspaceId && memberships.some((m) => m.id === workspaceId) ? workspaceId : null;
    return this.issue(user, active, memberships);
  }

  /** SP-26: after POST /auth/2fa/verify, the normal login payload. */
  async loginAfterTwoFactor(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: LOGIN_INCLUDE });
    if (!user) throw new UnauthorizedException("Invalid credentials");
    const res = await this.finishLogin(user, { secondFactorDone: true });
    if ("twoFactorRequired" in res) throw new UnauthorizedException("Invalid credentials"); // unreachable
    return res;
  }

  private async finishLogin(user: {
    id: string;
    email: string;
    name: string;
    role: string;
    initials: string;
    color: string;
    isSuperAdmin: boolean;
    twoFA?: boolean;
    sessionVersion?: number | null;
    memberships: {
      role: string;
      workspace: {
        id: string;
        name: string;
        slug: string;
        timezone: string;
        lang: string;
        plan: string;
        paymentDueSince?: Date | null;
      };
    }[];
  }, opts: { secondFactorDone?: boolean } = {}) {
    // SP-26: a password login with 2FA on returns a challenge, not a session.
    // (SSO bridges never come through here: ruling 9.)
    if (user.twoFA === true && !opts.secondFactorDone) {
      return { twoFactorRequired: true as const, challenge: await this.twoFactor.challengeFor(user) };
    }
    const memberships = user.memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      timezone: m.workspace.timezone,
      lang: m.workspace.lang,
      plan: m.workspace.plan,
      role: m.role as WorkspaceRole,
    }));

    if (memberships.length === 0) {
      // SP-26 (ruling 6): someone removed from a workspace, or with a pending
      // invitation, lands on the no-workspace page instead of in a fresh
      // empty workspace. (register still auto-creates.)
      if (await this.expectsNoWorkspace(user.id, user.email)) {
        return this.issue(user, null, []);
      }
      // Edge case: user with no workspace memberships. Create one on the fly
      // so they always land somewhere.
      const ws = await this.workspaces.create(
        { name: `${user.name}'s workspace` },
        user.id,
      );
      return this.issue(user, ws.id, [
        {
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          timezone: ws.timezone,
          lang: ws.lang,
          plan: ws.plan,
          role: "owner",
        },
      ]);
    }
    // Default into the first workspace so the JWT always carries a workspaceId
    // (downstream routes use @CurrentWorkspace which 401s if absent). Users
    // with multiple workspaces can switch from the topbar — that re-mints the
    // JWT via /auth/switch-workspace.
    // Land in a workspace that is not payment-locked. Only when every one is
    // locked is the login refused (super-admins are exempt, as at the guard).
    const now = new Date();
    const open = user.isSuperAdmin
      ? user.memberships
      : user.memberships.filter((m) => !isPaymentLocked(m.workspace.paymentDueSince ?? null, now));
    if (open.length === 0) throw paymentOverdue();
    const home = open[0].workspace.id;
    return this.issue(user, home, memberships);
  }

  /** A pending invitation for this email, or an audit record of the user's
   *  removal from some workspace (ruling 6). Both tables are unscoped. */
  private async expectsNoWorkspace(userId: string, email: string): Promise<boolean> {
    const [pending, removed] = await Promise.all([
      this.prisma.invitation.findFirst({
        where: { ...emailWhere(email), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      }),
      this.prisma.auditLog.findFirst({
        where: { action: "member.removed", targetKind: "member", targetId: userId },
        select: { id: true },
      }),
    ]);
    return !!pending || !!removed;
  }

  /** SP-26: a session for `userId` with `workspaceId` active (after an
   *  invitation is accepted). */
  async issueFor(userId: string, workspaceId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.workspaces.listForUser(userId);
    return this.issue(user, workspaceId, memberships);
  }

  /** GET /auth/workspaces/by-slug/:slug (ruling 10): an unknown slug is 404;
   *  the slug of a workspace the user is not in gives `{ member: false }`
   *  without its id or name. */
  async workspaceBySlug(userId: string, slug: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!ws) throw new NotFoundException({ statusCode: 404, message: "workspaces.slug_not_found" });
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: ws.id } },
      select: { workspaceId: true },
    });
    if (!m || m.workspaceId !== ws.id) return { member: false as const };
    return { id: ws.id, name: ws.name, member: true as const };
  }

  async register(dto: RegisterDto) {
    // Stored normalised; a different-case duplicate of an existing account is refused.
    const email = normalizeEmail(dto.email);
    const exists = await this.prisma.user.findFirst({ where: emailWhere(email), select: { id: true } });
    if (exists) throw new ConflictException("Email already in use");
    const initials = dto.name
      .split(" ")
      .map((s) => s[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    // One transaction: user + workspace + membership + seeded defaults. A
    // failure anywhere rolls the user back too, so a retry is not a 409.
    const { workspace: ws, user } = await this.workspaces.createWithNewOwner(
      { name: dto.workspaceName ?? `${dto.name}'s workspace` },
      {
        email,
        password: await bcrypt.hash(dto.password, 10),
        name: dto.name,
        role: dto.role ?? "Agent",
        color: dto.color ?? "200",
        initials,
      },
    );
    const memberships = await this.workspaces.listForUser(user.id);
    return this.issue(user, ws.id, memberships);
  }

  async switchWorkspace(userId: string, dto: SwitchWorkspaceDto) {
    await this.workspaces.requireMember(userId, dto.workspaceId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.isSuperAdmin) {
      const ws = await this.prisma.raw.workspace.findUnique({
        where: { id: dto.workspaceId },
        select: { paymentDueSince: true },
      });
      if (ws && isPaymentLocked(ws.paymentDueSince, new Date())) throw paymentOverdue();
    }
    const memberships = await this.workspaces.listForUser(userId);
    return this.issue(user, dto.workspaceId, memberships);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    return this.shape(user);
  }

  async myWorkspaces(userId: string) {
    return this.workspaces.listForUser(userId);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    const data: { name?: string; color?: string; initials?: string } = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
      data.initials = dto.name
        .split(" ")
        .map((s) => s[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }
    if (dto.color !== undefined) data.color = dto.color;
    const updated = await this.prisma.user.update({ where: { id: userId }, data });
    if (dto.name !== undefined && dto.name !== user.name) void this.kewySync.profileChanged(updated);
    return this.shape(updated);
  }

  /** SP-26: also ends every other session (sessionVersion) and returns a
   *  fresh token for this one. */
  async changePassword(userId: string, dto: ChangePasswordDto, workspaceId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    // SSO-provisioned users have no local password — they can't change one via
    // this endpoint. They authenticate via /auth/sso/exchange on every visit.
    if (!user.password) {
      throw new BadRequestException("This account uses SSO and has no password");
    }
    const ok =
      (await bcrypt.compare(dto.currentPassword, user.password)) ||
      // Once Kewy checks logins, the password the user signs in with may be
      // their Kewy one rather than the local hash.
      (authSource() !== "local" && (await this.isKewyPassword(user, dto.currentPassword)));
    if (!ok) throw new BadRequestException("Current password is incorrect");
    const hash = await bcrypt.hash(dto.newPassword, 10);
    // Kewy first: a strict failure leaves the local password unchanged.
    await this.kewySync.passwordChanged(user, hash);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { password: hash, ...SessionVersionService.bump() },
    });
    this.sessions.bumped(userId);
    const memberships = await this.workspaces.listForUser(userId);
    const active = workspaceId && memberships.some((m) => m.id === workspaceId) ? workspaceId : null;
    const { token } = await this.issue(updated, active, memberships);
    return { ok: true, token };
  }

  /** True when Kewy accepts `password` for exactly this crm user. */
  private async isKewyPassword(
    user: { id: string; email: string; kewyAccountId: string | null },
    password: string,
  ): Promise<boolean> {
    const res = await this.kewy.authenticate({ identifier: user.email, password });
    if (res.kind !== "ok") return false;
    return (
      res.data.identities.some((i) => i.externalUserId === user.id) ||
      (user.kewyAccountId !== null && res.data.accountId === user.kewyAccountId)
    );
  }

  private async issue(
    // Full user row — every caller (login/register/switch) already loaded it,
    // so we sign directly from it instead of re-querying the DB (one fewer
    // round-trip to the remote Postgres on every auth call). isSuperAdmin is a
    // scalar on the row, so it reflects current DB state as of that read.
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      initials: string;
      color: string;
      isSuperAdmin: boolean;
      sessionVersion?: number | null;
    },
    workspaceId: string | null,
    workspaces: Awaited<ReturnType<WorkspacesService["listForUser"]>>,
  ) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      // SP-26 ruling 4: AuthGuard compares this with User.sessionVersion.
      sv: user.sessionVersion ?? 0,
      ...(workspaceId ? { workspaceId } : {}),
      ...(user.isSuperAdmin ? { isSuperAdmin: true } : {}),
    };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      user: this.shape(user),
      workspaces,
      activeWorkspaceId: workspaceId,
    };
  }

  private shape(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    initials: string;
    color: string;
    isSuperAdmin: boolean;
    twoFA?: boolean;
  }) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      initials: u.initials,
      color: u.color,
      isSuperAdmin: u.isSuperAdmin,
      // SP-26: whether TOTP is on; never the secret or recovery codes.
      twoFA: u.twoFA === true,
    };
  }
}
