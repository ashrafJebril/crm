import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { layoutBrandOf } from "../workspaces/email-brand";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";
import { twoFactorResetEmail } from "../email/templates/two-factor-reset";
import { decryptSecret, encryptSecret, isTokenEncryptionEnabled } from "../common/token-crypto";
import { SlidingWindowLimiter } from "../common/rate-limit";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { isEffectiveOwner } from "../permissions/member-role";
import { findWorkspaceMember } from "../members/member-guards";
import { TWO_FA_CHALLENGE_TTL_S } from "../members/members-constants";
import { authError } from "./auth-errors";
import { generateRecoveryCodes, hashRecoveryCodes, matchRecoveryCode } from "./recovery-codes";
import { SessionVersionService } from "./session-version.service";
import { base32Encode, otpauthUrl, verifyTotp } from "./totp";

const MIN15 = 15 * 60_000;

/** What a 2FA challenge JWT carries. AuthGuard refuses any token with a
 *  `purpose`, so a challenge is never a session. */
export interface ChallengePayload {
  sub: string;
  purpose: "2fa";
  sv: number;
}

/** Exactly one of a TOTP code or a recovery code. */
export interface SecondFactor {
  code?: string;
  recoveryCode?: string;
}

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

/** Which factor was given; 400 auth.2fa_code_invalid for both or neither. */
function oneFactor(f: SecondFactor): "code" | "recovery" {
  const hasCode = typeof f.code === "string" && f.code !== "";
  const hasRecovery = typeof f.recoveryCode === "string" && f.recoveryCode !== "";
  if (hasCode === hasRecovery) throw authError("auth.2fa_code_invalid");
  return hasCode ? "code" : "recovery";
}

/** Every TOTP field cleared (disable and owner reset). */
const CLEARED = {
  twoFA: false,
  totpSecretEnc: null,
  totpPendingEnc: null,
  totpEnabledAt: null,
  totpLastStep: null,
  totpRecoveryHashes: [] as string[],
};

/**
 * SP-26 TOTP two-step verification (ruling 3). Secrets are encrypted with
 * TOKEN_ENC_KEY and never returned after setup; recovery codes are stored
 * only as bcrypt and work once; a code is good once (totpLastStep). Every
 * verification of one user runs under an advisory lock, so two concurrent
 * attempts cannot both spend the same step or recovery code. Nothing here
 * logs a secret, code or password.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  now: () => Date = () => new Date();
  readonly bySub = new SlidingWindowLimiter({ limit: 10, windowMs: MIN15 });
  readonly byIp = new SlidingWindowLimiter({ limit: 30, windowMs: MIN15 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly sessions: SessionVersionService,
    private readonly permissions: PermissionService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  private async user(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw authError("auth.session_expired");
    return u;
  }

  /** POST /auth/2fa/setup: a fresh 20-byte secret, stored encrypted as
   *  pending, returned once. Production refuses without TOKEN_ENC_KEY. */
  async setup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    if (process.env.NODE_ENV === "production" && !isTokenEncryptionEnabled()) {
      throw authError("auth.encryption_unavailable");
    }
    const u = await this.user(userId);
    if (u.twoFA) throw authError("auth.2fa_already_enabled");
    const secret = base32Encode(randomBytes(20));
    await this.prisma.user.update({ where: { id: u.id }, data: { totpPendingEnc: encryptSecret(secret) } });
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  /** POST /auth/2fa/enable {code}: confirms the pending secret, ends every
   *  other session (the caller re-issues this one), and returns the recovery
   *  codes once. */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (u.twoFA) throw authError("auth.2fa_already_enabled");
    const pending = u.totpPendingEnc ? decryptSecret(u.totpPendingEnc) : null;
    if (!pending) throw authError("auth.2fa_not_enabled");
    const step = verifyTotp(pending, code, this.now().getTime(), null);
    if (step === null) throw authError("auth.2fa_code_invalid");
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.user.updateMany({
        where: { id: u.id, twoFA: false, totpPendingEnc: u.totpPendingEnc },
        data: {
          twoFA: true,
          totpSecretEnc: u.totpPendingEnc,
          totpPendingEnc: null,
          totpEnabledAt: this.now(),
          totpLastStep: step,
          totpRecoveryHashes: hashes,
          ...SessionVersionService.bump(),
        },
      });
      if (res.count === 0) throw authError("auth.2fa_already_enabled");
      await this.audit.recordForUser(tx, u.id, { actorId: u.id, action: "security.2fa_enabled", targetKind: "user", targetId: u.id });
    });
    this.sessions.bumped(u.id);
    return { recoveryCodes: codes };
  }

  /** POST /auth/2fa/disable {password, code | recoveryCode}: clears every
   *  TOTP field and ends every session. */
  async disable(userId: string, password: string, factor: SecondFactor): Promise<{ ok: true }> {
    const u = await this.user(userId);
    if (!u.twoFA || !u.totpSecretEnc) throw authError("auth.2fa_not_enabled");
    await this.assertPassword(u.password, password);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, u.id);
      const fresh = await tx.user.findUnique({ where: { id: u.id } });
      if (!fresh?.twoFA || !fresh.totpSecretEnc) throw authError("auth.2fa_not_enabled");
      await this.spendSecondFactor(tx, fresh, factor);
      await tx.user.update({ where: { id: u.id }, data: { ...CLEARED, ...SessionVersionService.bump() } });
      await this.audit.recordForUser(tx, u.id, { actorId: u.id, action: "security.2fa_disabled", targetKind: "user", targetId: u.id });
    });
    this.sessions.bumped(u.id);
    return { ok: true };
  }

  /** POST /auth/2fa/recovery-codes {password, code | recoveryCode}: replaces
   *  every recovery code; the new ones are returned once. */
  async regenerateRecoveryCodes(userId: string, password: string, factor: SecondFactor): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (!u.twoFA || !u.totpSecretEnc) throw authError("auth.2fa_not_enabled");
    await this.assertPassword(u.password, password);
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, u.id);
      const fresh = await tx.user.findUnique({ where: { id: u.id } });
      if (!fresh?.twoFA || !fresh.totpSecretEnc) throw authError("auth.2fa_not_enabled");
      await this.spendSecondFactor(tx, fresh, factor);
      await tx.user.update({ where: { id: u.id }, data: { totpRecoveryHashes: hashes } });
      await this.audit.recordForUser(tx, u.id, {
        actorId: u.id,
        action: "security.2fa_recovery_codes_regenerated",
        targetKind: "user",
        targetId: u.id,
      });
    });
    return { recoveryCodes: codes };
  }

  /** The login challenge for a user with 2FA on: a 5-minute JWT that only
   *  POST /auth/2fa/verify accepts. */
  challengeFor(user: { id: string; sessionVersion?: number | null }): Promise<string> {
    const payload: ChallengePayload = { sub: user.id, purpose: "2fa", sv: user.sessionVersion ?? 0 };
    return this.jwt.signAsync(payload, { expiresIn: TWO_FA_CHALLENGE_TTL_S });
  }

  /**
   * POST /auth/2fa/verify (public): a valid challenge plus exactly one of a
   * TOTP code or a recovery code. Returns the user id; the caller issues
   * the normal login payload. 10 tries per challenge user and 30 per IP per
   * 15 min.
   */
  async verify(input: { challenge: unknown } & SecondFactor, ip?: string): Promise<string> {
    const ipHit = this.byIp.hit(`ip:${ip ?? "unknown"}`);
    if (!ipHit.ok) throw authError("auth.rate_limited", { retryAfterSec: ipHit.retryAfterSec });
    let claims: Partial<ChallengePayload>;
    try {
      claims = await this.jwt.verifyAsync<ChallengePayload>(String(input.challenge ?? ""));
    } catch {
      throw authError("auth.2fa_challenge_invalid");
    }
    if (claims.purpose !== "2fa" || typeof claims.sub !== "string") throw authError("auth.2fa_challenge_invalid");
    const subHit = this.bySub.hit(`sub:${claims.sub}`);
    if (!subHit.ok) throw authError("auth.rate_limited", { retryAfterSec: subHit.retryAfterSec });
    oneFactor(input);

    const userId = claims.sub;
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u || !u.twoFA || !u.totpSecretEnc || (u.sessionVersion ?? 0) !== (claims.sv ?? 0)) {
        throw authError("auth.2fa_challenge_invalid");
      }
      await this.spendSecondFactor(tx, u, input);
    });
    return userId;
  }

  private async assertPassword(hash: string | null, password: string): Promise<void> {
    if (!hash || typeof password !== "string" || !(await bcrypt.compare(password, hash))) {
      throw new BadRequestException("Current password is incorrect");
    }
  }

  /**
   * Checks and spends exactly one second factor inside `tx` (the caller holds
   * the user's advisory lock): a TOTP code moves totpLastStep forward (a step
   * is good once); a recovery code's hash is removed (good once) and audited.
   */
  private async spendSecondFactor(
    tx: Tx,
    u: { id: string; totpSecretEnc: string | null; totpLastStep: number | null; totpRecoveryHashes: string[] | null },
    factor: SecondFactor,
  ): Promise<void> {
    const kind = oneFactor(factor);
    if (kind === "code") {
      const step = verifyTotp(decryptSecret(u.totpSecretEnc as string), factor.code as string, this.now().getTime(), u.totpLastStep);
      if (step === null) throw authError("auth.2fa_code_invalid");
      const res = await tx.user.updateMany({
        where: { id: u.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      if (res.count === 0) throw authError("auth.2fa_code_invalid");
      return;
    }
    const hashes = u.totpRecoveryHashes ?? [];
    const hash = await matchRecoveryCode(factor.recoveryCode as string, hashes);
    if (!hash) throw authError("auth.2fa_code_invalid");
    const res = await tx.user.updateMany({
      where: { id: u.id, totpRecoveryHashes: { has: hash } },
      data: { totpRecoveryHashes: hashes.filter((h) => h !== hash) },
    });
    if (res.count === 0) throw authError("auth.2fa_code_invalid");
    await this.audit.recordForUser(tx, u.id, {
      actorId: u.id,
      action: "security.2fa_recovery_code_used",
      targetKind: "user",
      targetId: u.id,
      meta: { remaining: hashes.length - 1 },
    });
  }

  /**
   * POST /workspaces/:id/members/:userId/2fa/reset (members.manage): an owner
   * or admin turns a member's 2FA off. Refused when the member belongs to
   * another workspace (the resetMemberPassword rule; super-admins bypass),
   * for an owner target unless the actor is an owner, and for impersonators.
   * Ends the member's sessions, emails them and audits.
   */
  async resetByOwner(workspaceId: string, userId: string, actor: Actor): Promise<{ ok: true }> {
    if (actor.impersonating && !actor.isSuperAdmin) {
      throw new ForbiddenException({ statusCode: 403, message: "Not allowed during impersonation" });
    }
    const m = await findWorkspaceMember(this.prisma, workspaceId, userId);
    await this.permissions.assertCanActOn(workspaceId, actor, userId);
    if (isEffectiveOwner(m)) {
      await this.permissions.assertOwner(workspaceId, actor, "Only an owner can reset an owner's two-step verification");
    }
    if (!actor.isSuperAdmin) {
      const other = await this.prisma.workspaceMember.count({ where: { userId, workspaceId: { not: workspaceId } } });
      if (other > 0) {
        throw new ForbiddenException("User belongs to other workspaces — they must manage their own two-step verification.");
      }
    }
    const u = await this.user(userId);
    if (!u.twoFA) throw authError("auth.2fa_not_enabled");
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: u.id }, data: { ...CLEARED, ...SessionVersionService.bump() } });
      await this.audit.record(tx, {
        workspaceId,
        actorId: actor.userId,
        action: "security.2fa_reset_by_owner",
        targetKind: "member",
        targetId: u.id,
      });
    });
    this.sessions.bumped(u.id);
    if (this.email.enabled) {
      try {
        const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, lang: true, logoMediaId: true, brandColor: true } });
        await this.email.send(
          // SP-29: the workspace's logo and colour.
          twoFactorResetEmail({ to: u.email, lang: ws?.lang === "en" ? "en" : "ar", name: u.name, workspaceName: ws?.name ?? "", brand: layoutBrandOf(ws) }),
        );
      } catch (e) {
        this.logger.warn(`2fa reset email for user ${u.id} failed: ${(e as Error)?.name ?? "Error"}`);
      }
    }
    return { ok: true };
  }

  /** Serialises one user's verifications (step replay, recovery codes). */
  private async lock(tx: { $executeRaw: PrismaService["$executeRaw"] }, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`2fa:${userId}`}))`;
  }
}
