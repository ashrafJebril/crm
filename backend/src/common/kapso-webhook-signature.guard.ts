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
 * Verifies Kapso's `X-Webhook-Signature` (HMAC-SHA256 hex of the raw body,
 * keyed by KAPSO_WEBHOOK_SECRET) before any webhook handler runs, so forged
 * inbound payloads can't inject messages. Fails closed if the secret is unset.
 *
 * Requires `rawBody: true` on the Nest app (main.ts).
 */
@Injectable()
export class KapsoWebhookSignatureGuard implements CanActivate {
  private readonly log = new Logger(KapsoWebhookSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.KAPSO_WEBHOOK_SECRET;
    if (!secret) {
      this.log.error("Rejecting Kapso webhook: KAPSO_WEBHOOK_SECRET not set");
      throw new ForbiddenException("Kapso webhook verification unavailable");
    }
    const header = (req.header("x-webhook-signature") ?? "").replace(/^sha256=/, "");
    if (!req.rawBody || !header) {
      throw new ForbiddenException("Missing Kapso webhook signature");
    }
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody)
      .digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      this.log.warn("Rejected Kapso webhook with invalid signature");
      throw new ForbiddenException("Invalid Kapso webhook signature");
    }
    return true;
  }
}
