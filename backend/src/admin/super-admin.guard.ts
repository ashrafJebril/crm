import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";

/** Gates a controller (or handler) to super-admins only. Used on AdminController.
 *  Assumes AuthGuard already populated req.user from a verified JWT. */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    if (!req.user?.isSuperAdmin) {
      throw new ForbiddenException("Super-admin access required");
    }
    return true;
  }
}
