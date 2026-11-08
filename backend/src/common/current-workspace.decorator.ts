import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import type { Viewer } from "../permissions/visibility";

/** Controller-level decorator: returns the workspaceId from the JWT payload.
 *  Throws 401 if absent (e.g., token from before multi-tenancy, or user
 *  hasn't picked a workspace yet). */
export const CurrentWorkspace = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const wsId = req.user?.workspaceId;
    if (!wsId) {
      throw new UnauthorizedException("No workspace selected");
    }
    return wsId;
  },
);

/** Returns userId (the JWT `sub` claim) from the request. */
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const sub = req.user?.sub;
    if (!sub) throw new UnauthorizedException("No user");
    return sub;
  },
);

/** The requesting member for visibility checks. Super-admin and impersonation
 *  sessions are flagged `bypass` and see every conversation. */
export const CurrentViewer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Viewer => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const u = req.user;
    if (!u?.sub) throw new UnauthorizedException("No user");
    return { userId: u.sub, bypass: !!(u.isSuperAdmin || u.impersonating) };
  },
);
