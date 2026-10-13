import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { TiremallSsoExchangeDto } from "./dto";

/** Claims the Tiremall backend signs on a handoff token (HS256, shared secret). */
interface TiremallClaims {
  sub: string;
  jti: string;
  exp: number;
  role?: string;
  email?: string;
  name?: string;
}

/**
 * Exchanges a short-lived Tiremall handoff token for an ordinary crm session
 * inside the single fixed Tiremall workspace. Separate from the hjz and Kewy
 * bridges on purpose (own columns, own env var).
 *
 * Inert until TIREMALL_SSO_SECRET is set.
 */
@Injectable()
export class TiremallSsoService {
  private readonly logger = new Logger(TiremallSsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async exchange(body: TiremallSsoExchangeDto) {
    const secret = process.env.TIREMALL_SSO_SECRET;
    if (!secret) {
      throw new ForbiddenException("Tiremall SSO is not configured");
    }
    // A shared secret would let a crm/hjz-signed token be replayed here (and
    // vice versa). Refuse rather than run with a reused key.
    if (
      secret === process.env.JWT_SECRET ||
      secret === process.env.HJZ_JWT_ACCESS_SECRET
    ) {
      this.logger.error(
        "TIREMALL_SSO_SECRET must not equal JWT_SECRET or HJZ_JWT_ACCESS_SECRET",
      );
      throw new ForbiddenException("Tiremall SSO is misconfigured");
    }

    let claims: TiremallClaims;
    try {
      claims = await this.jwt.verifyAsync<TiremallClaims>(body.token, {
        // Per-call secret outranks the module-global crm secret.
        secret,
        // Pinned: never let the token header choose the algorithm.
        algorithms: ["HS256"],
        issuer: "tiremall",
        audience: "kewy-crm",
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired Tiremall token");
    }
    if (!claims?.sub || !claims?.jti) {
      throw new UnauthorizedException("Tiremall token is missing required claims");
    }

    // Single-use via the shared ssoNonce table (API runs several instances).
    try {
      await this.prisma.raw.ssoNonce.create({
        data: { jti: claims.jti, expiresAt: new Date(claims.exp * 1000) },
      });
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        throw new UnauthorizedException("Tiremall token has already been used");
      }
      throw cause;
    }
    // Opportunistic sweep; keeps the table from growing without a cron.
    await this.prisma.raw.ssoNonce
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);

    const workspace = await this.prisma.raw.workspace.upsert({
      where: { tiremallTenantId: "tiremall" },
      update: {},
      create: {
        name: "Tiremall",
        slug: await this.allocateSlug("tiremall"),
        tiremallTenantId: "tiremall",
      },
    });

    if (workspace.suspendedAt) {
      throw new ForbiddenException("This workspace is suspended");
    }

    const safeName = claims.name ?? "Tiremall User";
    const upsertUser = (email: string) =>
      this.prisma.raw.user.upsert({
        where: { tiremallUserId: claims.sub },
        update: claims.name ? { name: safeName, initials: initialsOf(safeName) } : {},
        create: {
          tiremallUserId: claims.sub,
          email: email.toLowerCase(),
          name: safeName,
          initials: initialsOf(safeName),
          role: "Agent",
          color: "150",
          // password stays NULL — Tiremall-provisioned users have no local password.
        },
      });
    const syntheticEmail = `tiremall_${claims.sub}@sso.local`;
    let user;
    try {
      user = await upsertUser(claims.email ?? syntheticEmail);
    } catch (cause) {
      const target = (cause as { meta?: { target?: unknown } })?.meta?.target;
      const emailTaken =
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002" &&
        (Array.isArray(target)
          ? target.some((t) => String(t).includes("email"))
          : String(target ?? "").includes("email"));
      if (!emailTaken || !claims.email) throw cause;
      // The email belongs to a different crm user. Never link to or modify
      // that account; provision a separate Tiremall identity instead.
      this.logger.warn(
        `tiremall sso: claim email already used by another crm user; using synthetic email for ${claims.sub}`,
      );
      user = await upsertUser(syntheticEmail);
    }

    const memberRole = mapTiremallRole(claims.role);
    await this.prisma.raw.workspaceMember.upsert({
      where: {
        userId_workspaceId: { userId: user.id, workspaceId: workspace.id },
      },
      update: { role: memberRole },
      create: { userId: user.id, workspaceId: workspace.id, role: memberRole },
    });

    const memberships = await this.workspaces.listForUser(user.id);
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      workspaceId: workspace.id,
      // isSuperAdmin deliberately NOT set (same rationale as Kewy).
    });

    this.logger.debug(
      `tiremall sso: user ${claims.sub} → crm user ${user.id} (workspace ${workspace.id})`,
    );

    return {
      token,
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        initials: user.initials,
        color: user.color,
      },
      workspaces: memberships,
      activeWorkspaceId: workspace.id,
    };
  }

  /** Mirror of WorkspacesService slug allocation — guarantees a unique slug. */
  private async allocateSlug(seed: string): Promise<string> {
    const base =
      seed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "workspace";
    let slug = base;
    let suffix = 0;
    while (await this.prisma.raw.workspace.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }
}

/** Tiremall admins become crm admins; everyone else is an agent. */
function mapTiremallRole(role: string | undefined): string {
  return (role ?? "").toUpperCase() === "ADMIN" ? "admin" : "agent";
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join("") || "TM"
  );
}
