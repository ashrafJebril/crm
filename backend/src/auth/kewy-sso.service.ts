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
import { KewySsoExchangeDto } from "./dto";

/**
 * Claims Kewy signs on a handoff token. Kewy is the control panel that owns
 * the customer's organization; `kw_workspace_id` is the shared reference every
 * product stores, and `kw_external_id` is this product's own workspace id when
 * Kewy already knows it.
 */
interface KewyClaims {
  sub: string;
  jti: string;
  exp: number;
  kw_workspace_id: string;
  kw_external_id?: string | null;
  kw_workspace_name?: string;
  kw_role?: string;
  email?: string;
  name?: string;
}

/**
 * Exchanges a short-lived Kewy handoff token for an ordinary crm session.
 *
 * Separate from SsoService (the hjz bridge) on purpose: that one is gated on
 * AUTH_MODE=sso and owns different columns (externalTenantId/externalId).
 * Entangling them would mean one env var silently disables both.
 *
 * Inert until KEWY_SSO_PUBLIC_KEY is set, so this can ship before Kewy does.
 */
@Injectable()
export class KewySsoService {
  private readonly logger = new Logger(KewySsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async exchange(body: KewySsoExchangeDto) {
    const publicKey = process.env.KEWY_SSO_PUBLIC_KEY?.replace(/\\n/g, "\n");
    if (!publicKey) {
      throw new ForbiddenException("Kewy SSO is not configured");
    }

    let claims: KewyClaims;
    try {
      claims = await this.jwt.verifyAsync<KewyClaims>(body.token, {
        // Passed as `secret`, not `publicKey`, on purpose. @nestjs/jwt's
        // getSecretKey resolves `options.secret || this.options.secret ||
        // options.publicKey`, and AuthModule registers JwtModule with a global
        // secret — so a per-call `publicKey` is silently outranked by crm's own
        // HS256 secret and every Kewy token fails to verify. jsonwebtoken
        // accepts a PEM public key here. The hjz bridge does the same.
        secret: publicKey,
        // Pinned explicitly. Without an allowlist both jsonwebtoken and
        // python-jose let the token's own header pick the algorithm, which
        // admits `alg: none` and HS256-confusion attacks against the public key.
        algorithms: ["RS256"],
        issuer: process.env.KEWY_ISSUER,
        audience: "crm",
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired Kewy token");
    }
    if (!claims?.sub || !claims?.kw_workspace_id || !claims?.jti) {
      throw new UnauthorizedException("Kewy token is missing required claims");
    }

    // Single-use. A unique-constraint violation means replay. This is a table
    // rather than an in-memory set because the API runs several instances on
    // Fly, and a per-process cache would let a replay through on any machine
    // that had not seen the token.
    try {
      await this.prisma.raw.ssoNonce.create({
        data: { jti: claims.jti, expiresAt: new Date(claims.exp * 1000) },
      });
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        throw new UnauthorizedException("Kewy token has already been used");
      }
      throw cause;
    }
    // Opportunistic sweep; keeps the table from growing without a cron.
    await this.prisma.raw.ssoNonce
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);

    // Resolve the workspace. Prefer the id Kewy already knows, so a workspace
    // provisioned before federation is matched rather than duplicated.
    const workspace = claims.kw_external_id
      ? await this.prisma.raw.workspace.update({
          where: { id: claims.kw_external_id },
          data: { kewyWorkspaceId: claims.kw_workspace_id },
        })
      : await this.prisma.raw.workspace.upsert({
          where: { kewyWorkspaceId: claims.kw_workspace_id },
          update: {},
          create: {
            name: claims.kw_workspace_name ?? "Kewy workspace",
            slug: await this.allocateSlug(
              claims.kw_workspace_name ?? `kewy-${claims.kw_workspace_id}`,
            ),
            kewyWorkspaceId: claims.kw_workspace_id,
          },
        });

    if (workspace.suspendedAt) {
      throw new ForbiddenException("This workspace is suspended");
    }

    const safeName = claims.name ?? "Kewy User";
    const user = await this.prisma.raw.user.upsert({
      where: { kewyAccountId: claims.sub },
      update: claims.name ? { name: safeName, initials: initialsOf(safeName) } : {},
      create: {
        kewyAccountId: claims.sub,
        email: (claims.email ?? `kewy_${claims.sub}@sso.local`).toLowerCase(),
        name: safeName,
        initials: initialsOf(safeName),
        role: "Agent",
        color: "150",
        // password stays NULL — Kewy-provisioned users have no local password.
      },
    });

    await this.prisma.raw.workspaceMember.upsert({
      where: {
        userId_workspaceId: { userId: user.id, workspaceId: workspace.id },
      },
      update: { role: mapKewyRole(claims.kw_role) },
      create: {
        userId: user.id,
        workspaceId: workspace.id,
        role: mapKewyRole(claims.kw_role),
      },
    });

    const memberships = await this.workspaces.listForUser(user.id);
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      workspaceId: workspace.id,
      // isSuperAdmin is deliberately NOT set. Kewy asserts the role, so
      // honouring a super-admin claim would make a Kewy compromise a
      // cross-tenant compromise of crm.
    });

    this.logger.debug(
      `kewy sso: account ${claims.sub} → crm user ${user.id} (workspace ${workspace.id})`,
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

/** Kewy roles are coarser than crm's; never map above "admin". */
function mapKewyRole(role: string | undefined): string {
  switch ((role ?? "").toUpperCase()) {
    case "OWNER":
      return "owner";
    case "ADMIN":
      return "admin";
    case "VIEWER":
      return "viewer";
    default:
      return "agent";
  }
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join("") || "KW"
  );
}
