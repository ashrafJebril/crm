import { Inject, Injectable, Logger } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";
import { resetEmail } from "../email/templates/reset";
import { emailLang } from "../email/templates/layout";
import { KewyIdentitySync } from "../kewy-identity/kewy-identity.sync";
import { authSource } from "../kewy-identity/auth-source";
import { SlidingWindowLimiter } from "../common/rate-limit";
import { PASSWORD_MIN, RESET_LIVE_MAX, RESET_TTL_MS } from "../members/members-constants";
import { appPublicUrl, hashToken, isTokenShape, newToken } from "../members/token-hash";
import { authError } from "./auth-errors";
import { SessionVersionService } from "./session-version.service";

const HOUR = 3_600_000;

/**
 * SP-26 password reset (ruling 5). `forgot` answers 202 for every email,
 * known or not, and does the work after the response; only a user with a
 * local password (and, under Kewy, one Kewy does not manage) gets a link.
 * Tokens are stored only as sha256, live 30 min and work once; a reset ends
 * every session. Nothing here logs a token, link, password or address.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  now: () => Date = () => new Date();
  readonly byEmail = new SlidingWindowLimiter({ limit: 5, windowMs: HOUR });
  readonly byIp = new SlidingWindowLimiter({ limit: 20, windowMs: HOUR });
  readonly resetByIp = new SlidingWindowLimiter({ limit: 10, windowMs: HOUR });
  /** The last background send (specs await it). */
  pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly kewySync: KewyIdentitySync,
    private readonly sessions: SessionVersionService,
  ) {}

  /** POST /auth/password/forgot: always `{ok: true}` (202), unless rate-limited. */
  forgot(emailRaw: string, lang: unknown, ip: string | undefined): { ok: true } {
    const email = String(emailRaw ?? "").trim().toLowerCase();
    const emailKey = createHash("sha256").update(email).digest("hex");
    const a = this.byIp.hit(`ip:${ip ?? "unknown"}`);
    const b = a.ok ? this.byEmail.hit(`email:${emailKey}`) : a;
    if (!a.ok || !b.ok) throw authError("auth.rate_limited", { retryAfterSec: Math.max(a.retryAfterSec, b.retryAfterSec) });
    // After the response: the time taken never depends on the account.
    this.pending = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.sendIfEligible(email, emailLang(lang), ip))
      .catch((e: unknown) => this.logger.warn(`password reset request failed: ${(e as Error)?.name ?? "Error"}`));
    return { ok: true };
  }

  /** Only local-password users get a link (ruling 5). */
  private eligible(user: { password: string | null; kewyAccountId: string | null } | null): boolean {
    if (!user || !user.password) return false;
    const mode = authSource();
    if (mode === "kewy") return false;
    if (mode === "kewy_with_fallback") return user.kewyAccountId === null;
    return true;
  }

  async sendIfEligible(email: string, lang: "ar" | "en", ip: string | undefined): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, password: true, kewyAccountId: true },
    });
    if (!this.eligible(user) || !user) return;
    if (!this.email.enabled) return; // ruling 1: no reset link without email
    const token = newToken();
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      // At most RESET_LIVE_MAX live rows: retire the oldest before adding one.
      const live = await tx.passwordReset.findMany({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const retire = live.slice(RESET_LIVE_MAX - 1).map((r) => r.id);
      if (retire.length) await tx.passwordReset.updateMany({ where: { id: { in: retire } }, data: { usedAt: now } });
      await tx.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + RESET_TTL_MS),
          requestedIp: ip ? ip.slice(0, 64) : null,
          createdAt: now,
        },
      });
    });
    await this.email.send(
      resetEmail({
        to: user.email,
        lang,
        name: user.name,
        link: `${appPublicUrl()}/reset?token=${encodeURIComponent(token)}`,
        minutes: Math.round(RESET_TTL_MS / 60_000),
      }),
    );
  }

  /** POST /auth/password/reset: one 410 for every invalid, used or expired token. */
  async reset(token: unknown, password: unknown, ip?: string): Promise<{ ok: true }> {
    const hit = this.resetByIp.hit(`ip:${ip ?? "unknown"}`);
    if (!hit.ok) throw authError("auth.rate_limited", { retryAfterSec: hit.retryAfterSec });
    if (typeof password !== "string" || password.length < PASSWORD_MIN) throw authError("auth.password_too_short");
    if (!isTokenShape(token)) throw authError("auth.reset_invalid");
    const now = this.now();
    const row = await this.prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) throw authError("auth.reset_invalid");
    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || !this.eligible(user)) throw authError("auth.reset_invalid");
    const hashed = await bcrypt.hash(password, 10);
    // Consume first (compare-and-set): of two concurrent submits exactly one
    // continues, so Kewy and the local hash can never diverge. A strict Kewy
    // failure after this leaves the old password and a spent link; the user
    // asks for a new one.
    const used = await this.prisma.passwordReset.updateMany({
      where: { id: row.id, tokenHash: row.tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count === 0) throw authError("auth.reset_invalid");
    await this.kewySync.passwordReset(user, hashed);
    await this.prisma.$transaction(async (tx) => {
      // Every other live link dies too.
      await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await tx.user.update({ where: { id: user.id }, data: { password: hashed, ...SessionVersionService.bump() } });
      await this.audit.recordForUser(tx, user.id, {
        actorId: user.id,
        action: "security.password_reset",
        targetKind: "user",
        targetId: user.id,
      });
    });
    this.sessions.bumped(user.id);
    return { ok: true };
  }
}
