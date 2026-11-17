import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Request, Response } from "express";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { PaymentLockService, paymentOverdue } from "../billing/payment-lock.service";
import { SessionVersionService } from "./session-version.service";
import { authError } from "./auth-errors";
import type { PermissionsJson } from "../permissions/catalog";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { looksLikeApiKey } from "../api-keys/api-key-format";
import { apiKeyError } from "../api-keys/api-key-errors";

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
  /** SP-27: set (by AuthGuard, never from a token) when the request
   *  authenticated with an API key; `sub` is then the key's creator. */
  apiKeyId?: string;
  /** SP-27: the key's scopes as catalogue permissions. */
  apiKeyPermissions?: PermissionsJson;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly paymentLock: PaymentLockService,
    private readonly sessions: SessionVersionService,
    // SP-27: absent only in hand-built specs (a crm_ token is then refused).
    @Optional() private readonly apiKeys?: ApiKeysService,
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
    // SP-27: an API key never reaches the JWT verifier, and the JWT-only
    // checks (session version, purpose) do not apply to it.
    if (looksLikeApiKey(token)) return this.authenticateApiKey(ctx, req, token);
    let user: JwtPayload;
    try {
      user = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    // Only AuthGuard sets the API-key fields; a token never carries them.
    delete user.apiKeyId;
    delete user.apiKeyPermissions;
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

  private async authenticateApiKey(
    ctx: ExecutionContext,
    req: Request & { user?: JwtPayload },
    token: string,
  ): Promise<boolean> {
    if (!this.apiKeys) throw apiKeyError("api_keys.invalid");
    const key = await this.apiKeys.authenticate(token);
    const limit = this.apiKeys.limiter.hit(key.id);
    if (!limit.ok) {
      ctx.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(limit.retryAfterSec));
      throw apiKeyError("api_keys.rate_limited", { retryAfter: limit.retryAfterSec });
    }
    req.user = {
      sub: key.createdById,
      email: "",
      role: "api_key",
      workspaceId: key.workspaceId,
      apiKeyId: key.id,
      apiKeyPermissions: key.permissions,
    };
    // The payment lock applies to keys as to sessions (fail closed).
    if (await this.paymentLock.isLocked(key.workspaceId)) throw paymentOverdue();
    return true;
  }
}
