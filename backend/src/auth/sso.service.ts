import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { SsoExchangeDto } from "./dto";

/**
 * Shape of an hjz-v2 access-token payload. hjz signs
 * `{ sub, tid, role, customRoleId?, employeeId? }`. We only depend on the
 * first three; everything else is tolerated.
 */
interface HjzTokenPayload {
  sub: string;
  tid: string | null;
  role: string;
  customRoleId?: string;
  employeeId?: string;
  iat?: number;
  exp?: number;
}

/**
 * Bridges hjz-v2 identity into tkana WITHOUT sharing a database.
 *
 * Flow: verify an hjz access token → upsert a mirrored Workspace + User
 * keyed off the hjz `sub` / `tid` (stored in Workspace.externalTenantId /
 * User.externalId) → ensure a WorkspaceMember row → issue a normal tkana
 * session JWT.
 *
 * Every existing tkana guard, workspace-scope rule and route keeps working
 * unchanged because the returned token is an ordinary tkana JWT carrying
 * tkana's own primary-key cuids. This path is inert unless AUTH_MODE=sso,
 * so standalone tkana is untouched.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async exchange(body: SsoExchangeDto) {
    if ((process.env.AUTH_MODE ?? "standalone") !== "sso") {
      throw new ForbiddenException("SSO exchange is disabled (AUTH_MODE is not 'sso')");
    }
    const hjzSecret = process.env.HJZ_JWT_ACCESS_SECRET;
    if (!hjzSecret) {
      throw new InternalServerErrorException("HJZ_JWT_ACCESS_SECRET is not configured");
    }

    // 1. Verify the hjz token with hjz's secret (NOT tkana's signing secret).
    //    Passing { secret } overrides the module-default secret per-call.
    let payload: HjzTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<HjzTokenPayload>(body.token, { secret: hjzSecret });
    } catch {
      throw new UnauthorizedException("Invalid or expired hjz token");
    }
    if (!payload?.sub || !payload?.tid) {
      throw new UnauthorizedException(
        "hjz token has no tenant (tid); SSO requires a tenant-scoped user",
      );
    }
    const { sub, tid } = payload;

    // 2. Upsert the mirrored Workspace (keyed by hjz tenant id).
    const workspace = await this.prisma.workspace.upsert({
      where: { externalTenantId: tid },
      update: {},
      create: {
        name: `HJZ ${tid.slice(0, 8)}`,
        slug: await this.allocateSlug(`hjz-${tid}`),
        externalTenantId: tid,
      },
    });

    // 3. Upsert the mirrored User (keyed by hjz user id).
    const safeEmail = (body.email ?? `hjz_${sub}@sso.local`).toLowerCase();
    const safeName = body.name ?? "HJZ User";
    const initials =
      safeName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "HJ";

    const user = await this.prisma.user.upsert({
      where: { externalId: sub },
      update: body.name ? { name: body.name, initials } : {},
      create: {
        externalId: sub,
        email: safeEmail,
        name: safeName,
        initials,
        // System-level User.role is informational; the workspace-scoped role
        // on WorkspaceMember is what auth checks consult.
        role: "Agent",
        color: "150",
        // password stays NULL — SSO users have no local password.
      },
    });

    // 4. Ensure a WorkspaceMember row exists (idempotent). Mapped role mirrors
    //    hjz's role coarsely — admins land as "admin", everyone else as "agent".
    const memberRole = mapRole(payload.role);
    await this.prisma.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: { role: memberRole },
      create: { userId: user.id, workspaceId: workspace.id, role: memberRole },
    });

    // 5. Issue a standard tkana session token (same shape as auth.service.login's
    //    private issue()). Workspace memberships list mirrors what /auth/me reads.
    const memberships = await this.workspaces.listForUser(user.id);
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      workspaceId: workspace.id,
    });

    this.logger.debug(
      `sso exchange: hjz user ${sub} → tkana user ${user.id} (workspace ${workspace.id})`,
    );

    return {
      // Provide both field names so callers don't care about the alias:
      //   - `token`       — what tkana's existing login response uses.
      //   - `accessToken` — what hjz's MarketingLauncher reads off the
      //     response body before stashing it in the new tab's URL fragment.
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
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "workspace";
    let candidate = base;
    let i = 1;
    while (await this.prisma.workspace.findUnique({ where: { slug: candidate } })) {
      i += 1;
      candidate = `${base}-${i}`;
      if (i > 50) {
        throw new InternalServerErrorException("Could not allocate a unique slug");
      }
    }
    return candidate;
  }
}

/** Map an hjz role string onto a tkana workspace-member role. Conservative default. */
function mapRole(hjzRole: string): string {
  switch (hjzRole.toUpperCase()) {
    case "OWNER":
      return "owner";
    case "ADMIN":
    case "PLATFORM_ADMIN":
    case "TENANT_ADMIN":
    case "SUPER_ADMIN":
      return "admin";
    default:
      return "agent";
  }
}
