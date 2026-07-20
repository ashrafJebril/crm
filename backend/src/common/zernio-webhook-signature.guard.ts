import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import type { Request } from "express";

/**
 * Verifies Zernio's `X-Zernio-Signature` (lowercase hex HMAC-SHA256 of the raw
 * body, keyed by ZERNIO_WEBHOOK_SECRET) before any webhook handler runs, so
 * forged inbound payloads can't inject messages. Fails closed if the secret is
 * unset. The legacy `X-Late-Signature` header (Zernio was formerly Getlate) is
 * accepted as a fallback.
 *
 * Requires `rawBody: true` on the Nest app (main.ts).
 */
@Injectable()
export class ZernioWebhookSignatureGuard implements CanActivate {
  private readonly log = new Logger(ZernioWebhookSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;
    if (!secret) {
      this.log.error("Rejecting Zernio webhook: ZERNIO_WEBHOOK_SECRET not set");
      throw new ForbiddenException("Zernio webhook verification unavailable");
    }
    const header = (
      req.header("x-zernio-signature") ??
      req.header("x-late-signature") ??
      ""
    ).replace(/^sha256=/, "");
    if (!req.rawBody || !header) {
      throw new ForbiddenException("Missing Zernio webhook signature");
    }
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      this.log.warn("Rejected Zernio webhook with invalid signature");
      throw new ForbiddenException("Invalid Zernio webhook signature");
    }
    return true;
  }
}
