import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { Request } from "express";
import { verifyMetaSignature } from "./meta-signature.util";
import { metaWebhookSecrets } from "./meta-app";

/**
 * Guard for Meta webhook POST endpoints. Verifies the `X-Hub-Signature-256`
 * HMAC so forged inbound payloads (fake messages, fake delivery/template
 * status flips) are rejected before any handler runs.
 *
 * Secrets are resolved from the request path (see `metaWebhookSecrets`):
 *   /webhooks/whatsapp  → META_APP_SECRET_WA and META_APP_SECRET (either
 *                         may sign while legacy WA-app customers are live)
 *   /webhooks/meta      → META_APP_SECRET
 *
 * Requires `rawBody: true` on the Nest app (see main.ts) so `req.rawBody`
 * holds the exact bytes Meta signed. Fails closed if the secret is unset.
 */
@Injectable()
export class MetaWebhookSignatureGuard implements CanActivate {
  private readonly log = new Logger(MetaWebhookSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & { rawBody?: Buffer }
    >();

    const isWhatsApp = (req.originalUrl ?? req.url ?? "").includes(
      "/webhooks/whatsapp",
    );
    const secrets = metaWebhookSecrets(isWhatsApp ? "whatsapp" : "meta");

    if (secrets.length === 0) {
      this.log.error(
        `Rejecting webhook: ${isWhatsApp ? "META_APP_SECRET_WA/" : ""}META_APP_SECRET not configured — cannot verify signature`,
      );
      throw new ForbiddenException("Webhook signature verification unavailable");
    }

    const header = req.header("x-hub-signature-256") ?? undefined;
    const ok = secrets.some((secret) => verifyMetaSignature(req.rawBody, header, secret));
    if (!ok) {
      this.log.warn(
        `Rejected webhook with invalid signature (path=${req.originalUrl ?? req.url})`,
      );
      throw new ForbiddenException("Invalid webhook signature");
    }
    return true;
  }
}
