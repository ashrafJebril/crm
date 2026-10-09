import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

export const WORKSPACE_ROLES_KEY = "workspaceRoles";
export const WorkspaceRoles = (...roles: string[]) => SetMetadata(WORKSPACE_ROLES_KEY, roles);

/** Gates a controller (or handler) to workspace members holding one of the
 *  given WorkspaceMember.role values ("owner" | "admin" | "agent" | "viewer").
 *  Inert unless @WorkspaceRoles(...) is present (no metadata → allow).
 *  Assumes AuthGuard already populated req.user from a verified JWT. Runs
 *  BEFORE the WorkspaceInterceptor, so there is no AsyncLocalStorage workspace
 *  context yet — queries WorkspaceMember directly by an explicit where. */
@Injectable()
export class WorkspaceRolesGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      WORKSPACE_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles || roles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user as JwtPayload | undefined;
    if (!user || !user.workspaceId) {
      throw new UnauthorizedException("Missing workspace context");
    }

    // Impersonation sessions (super-admin acting inside a tenant) have no
    // WorkspaceMember row for that workspace — bypass the membership check.
    if (user.isSuperAdmin === true) return true;

    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId: user.sub, workspaceId: user.workspaceId },
      },
    });

    if (!member || !roles.includes(member.role)) {
      throw new ForbiddenException(`Requires workspace role: ${roles.join(", ")}`);
    }

    return true;
  }
}
