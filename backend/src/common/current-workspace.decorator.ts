import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";

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
