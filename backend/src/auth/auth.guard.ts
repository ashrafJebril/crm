import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { PaymentLockService, paymentOverdue } from "../billing/payment-lock.service";

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  workspaceId?: string;
  // tkana-internal super-admin: when true, the user can access /admin/*.
  isSuperAdmin?: boolean;
  // Marks an impersonation session — set when a super-admin entered another
  // tenant's workspace for support. Used for audit + UI banner.
  impersonating?: boolean;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly paymentLock: PaymentLockService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const token = auth.slice(7);
    let user: JwtPayload;
    try {
      user = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    req.user = user;

    // The JWT lasts 7 days, so a lock set after login must be enforced here.
    // Support sessions and tokens without a workspace are exempt. A failed
    // lookup propagates (500): fail closed, never silently unlock.
    if (user.workspaceId && !user.isSuperAdmin && !user.impersonating) {
      if (await this.paymentLock.isLocked(user.workspaceId)) throw paymentOverdue();
    }
    return true;
  }
}
