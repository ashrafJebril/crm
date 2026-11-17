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
import { SessionVersionService } from "./session-version.service";
import { authError } from "./auth-errors";

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
  /** SP-26 ruling 4: the user's sessionVersion when issued (absent = 0). */
  sv?: number;
  /** Set only on non-session tokens (the 2FA challenge); always refused. */
  purpose?: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly paymentLock: PaymentLockService,
    private readonly sessions: SessionVersionService,
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
    // SP-26: a 2FA challenge (or any purpose-bound token) is never a session.
    if (user.purpose !== undefined) throw new UnauthorizedException("Invalid or expired token");
    // SP-26 ruling 4: a reset, password change or 2FA change ends old sessions.
    if (!(await this.sessions.isCurrent(user.sub, user.sv))) throw authError("auth.session_expired");
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
