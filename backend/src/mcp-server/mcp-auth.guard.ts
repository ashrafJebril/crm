import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { McpTokenService } from "../integrations/mcp-token.service";

/**
 * Authenticates POST /api/mcp/v1 with a per-workspace bearer token instead of
 * the normal per-user JWT (this endpoint is called by the l platform, which
 * has no user session). Populates req.user so the existing @CurrentWorkspace()
 * decorator resolves the workspace exactly like every other controller.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly tokens: McpTokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const workspaceId = await this.tokens.findWorkspaceByToken(auth.slice(7));
    if (!workspaceId) {
      throw new UnauthorizedException("Invalid or revoked MCP token");
    }
    req.user = { sub: "mcp-server", email: "", role: "admin", workspaceId };
    return true;
  }
}
