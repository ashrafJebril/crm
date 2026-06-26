import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";

/**
 * Guards the /api/joteck/* surface that the JOTECK admin app calls.
 * Verifies a shared HMAC secret in the `x-joteck-secret` header against
 * the JOTECK_CRM_SECRET env var using constant-time comparison.
 */
@Injectable()
export class JoteckGuard implements CanActivate {
  private readonly logger = new Logger(JoteckGuard.name);

  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.JOTECK_CRM_SECRET;
    if (!expected) {
      this.logger.error("JOTECK_CRM_SECRET is not configured");
      throw new ServiceUnavailableException("Joteck integration not configured");
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = (req.headers["x-joteck-secret"] as string | undefined) ?? "";
    if (!provided) throw new UnauthorizedException("Missing x-joteck-secret");

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Bad x-joteck-secret");
    }
    return true;
  }
}

// Re-export to advertise that all routes on JoteckController must also be
// marked @Public() so the global AuthGuard skips them.
export { Public };
